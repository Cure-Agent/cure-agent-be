import { Injectable } from '@nestjs/common';
import { DEFAULT_COMMON_DF_RATIO } from '../../../global/config/retrieval.config';
import { eojeolsOf, tokenize } from '../../../infrastructure/retrieval/query-tokenizer';
import { GuidelineRepository } from '../repository/guideline.repository';

/** 질의 토큰 1개의 DF 판정 결과 — 기준 1·4·5·6이 이 값을 직접 본다 */
export interface TokenSelection {
  /** 질의에서 잘린 토큰 (조사 절단 후) */
  token: string;
  /**
   * 부분문자열 DF — 이 토큰을 품은 어휘 항들의 **포스팅 합집합** 크기다.
   * 항별 `df`의 합이 아니다: 같은 청크가 여러 항에 걸쳐 겹세어지면 틀린다 (기준 1).
   */
  df: number;
  /** DF가 컷을 **초과**하면 흔한 토큰이라 후보 생성에 기여하지 않는다 (기준 4·5) */
  common: boolean;
}

/** `selectCandidates`의 결과 — `chunkIds`가 null이면 전량 스캔이다 (기준 10·11) */
export interface CandidateSelection {
  tokens: TokenSelection[];
  /** 희소 토큰 포스팅의 합집합. **후보 0건이면 null**로 접어 전량 스캔에 넘긴다 */
  chunkIds: string[] | null;
}

/** 전량 재생성 결과 (`scripts/rebuild-keyword-vocab.ts`) */
export interface VocabRebuildResult {
  terms: number;
  postings: number;
  chunks: number;
}

/** 인메모리 어휘 스냅샷 — 질의는 DB를 아예 건드리지 않는다 */
interface VocabSnapshot {
  terms: string[];
  /** `terms`와 같은 인덱스의 포스팅. 정수 배열이라 ULID 대비 표 14MB/38MB·로드 165ms/502ms다 */
  postings: Int32Array[];
  /** ix → chunk id. 포스팅이 가리키는 것을 검색 조건으로 되돌리는 유일한 경로다 */
  chunkIdByIx: (string | undefined)[];
  /**
   * DF 판정의 분모 — **어휘가 덮는 청크 수**(전 포스팅 합집합의 크기)다.
   * 어휘에서만 파생되므로 별도 count와 어긋날 수 없고, 어휘가 비면 0이 되어
   * 「후보 0건 → 전량 스캔」이 같은 규칙에서 나온다.
   */
  corpusSize: number;
  /** `mark` 배열 크기 = max(ix)+1. 구멍이 2배여도 Int32Array 57KB라 비용이 없다 */
  markSize: number;
}

/**
 * 키워드 arm 어휘 색인의 소유자 (docs/specs/45).
 *
 * **부분문자열 DF를 코퍼스가 아니라 어휘 위에서 센다.** 질의 토큰도 코퍼스 어절도 같은 문자
 * 클래스로 잘리므로, 질의 토큰이 `content`에 부분문자열로 나타나면 반드시 한 어절 안에 온전히
 * 들어간다 — 어절 경계를 걸칠 수 없다. 따라서 `⋃{포스팅(v) : 토큰 ⊂ v}`의 청크 수가 `ILIKE`
 * 매칭 청크 수와 **같다**(근사가 아니라 항등). 그 부산물로 후보 집합까지 나오므로 후보 생성이
 * DB를 아예 안 건드린다 — #402가 진 이유의 절반이 「후보 생성이 O(코퍼스)」였다.
 *
 * 어휘는 **ACTIVE 경계**로 정의된다 — 검색 대상 코퍼스와 같아야 한다. 그래서 인제스트만이
 * 아니라 관리자 경로(status 변경·삭제)도 훅을 건다: 어휘가 stale이면 폐기한 판본의 어절이
 * 후보를 계속 끌어오고 새 ACTIVE 판본의 어절은 영영 안 잡혀 **결과가 조용히 틀린다.**
 */
@Injectable()
export class KeywordVocabularyService {
  private snapshot: VocabSnapshot | null = null;
  /** 동시 질의가 같은 어휘를 두 번 읽지 않게 적재 중 promise를 공유한다 */
  private loading: Promise<VocabSnapshot> | null = null;

  constructor(private readonly repository: GuidelineRepository) {}

  /**
   * 토큰별 부분문자열 확장 → DF 판정 → 희소 토큰 포스팅 합집합.
   *
   * O(어휘 × 질의 토큰) 선형이며 prod 어휘(93,391항·47.7만 자 = 코퍼스의 5.37%)에서 27ms다.
   * 코퍼스가 자릿수로 커져 이 값이 문제로 관측되면 n-gram 역색인을 얹는다(Out of scope).
   */
  async selectCandidates(query: string): Promise<CandidateSelection> {
    const snapshot = await this.load();
    const tokens = tokenize(query);
    const threshold = this.commonDfThreshold(snapshot.corpusSize);

    // mark는 호출마다 새로 잡는다 — 재사용하면 동시 질의가 서로의 표식을 덮어쓴다.
    // prod 규모에서도 57KB라 할당 비용이 스캔 비용에 묻힌다.
    const tokenMark = new Int32Array(snapshot.markSize);
    const candidateMark = new Uint8Array(snapshot.markSize);
    const candidateIxs: number[] = [];
    const selections: TokenSelection[] = [];

    tokens.forEach((token, stamp) => {
      // stamp를 토큰마다 올려 mark를 지우지 않고 재사용한다 (0은 미표식이라 +1)
      const generation = stamp + 1;
      const matched: number[] = [];
      let df = 0;

      for (let index = 0; index < snapshot.terms.length; index += 1) {
        if (!snapshot.terms[index].includes(token)) continue;
        matched.push(index);
        for (const ix of snapshot.postings[index]) {
          if (tokenMark[ix] === generation) continue;
          tokenMark[ix] = generation;
          df += 1;
        }
      }

      // **초과**가 흔함이다 — 컷과 같으면 쓴다. 그래야 컷을 낮출수록 후보가 단조롭게 좁아진다
      const common = df > threshold;
      selections.push({ token, df, common });
      if (common) return;

      for (const index of matched) {
        for (const ix of snapshot.postings[index]) {
          if (candidateMark[ix] === 1) continue;
          candidateMark[ix] = 1;
          candidateIxs.push(ix);
        }
      }
    });

    const chunkIds: string[] = [];
    for (const ix of candidateIxs) {
      const chunkId = snapshot.chunkIdByIx[ix];
      if (chunkId !== undefined) chunkIds.push(chunkId);
    }

    // 후보 0건은 arm을 통째로 죽이는 것이라 **느린 것보다 나쁘다** — 하이브리드가 벡터 단독으로
    // 조용히 퇴화한다. 질의 토큰이 전부 흔하거나, 희소 토큰이 코퍼스에 없는 신조어뿐이거나,
    // 어휘가 비었을 때(백필 전 배포 창) 모두 여기로 온다.
    return { tokens: selections, chunkIds: chunkIds.length > 0 ? chunkIds : null };
  }

  /**
   * 판본의 어절을 어휘에 넣는다 (ACTIVE 진입·인제스트).
   * **호출자의 트랜잭션 안에서 돈다** — 실패하면 코퍼스 쓰기와 함께 롤백돼야 한다.
   */
  async applyVersion(versionId: string): Promise<void> {
    const chunks = await this.repository.listVersionChunkContents(versionId);
    if (chunks.length === 0) return;

    const ixByChunkId = await this.repository.assignChunkIxs(chunks.map((chunk) => chunk.id));
    await this.repository.mergeVocabPostings(postingsOf(chunks, ixByChunkId));
  }

  /**
   * 판본의 어절을 어휘에서 뺀다 (ACTIVE 이탈·삭제).
   * 포스팅이 **집합**이라 다른 ACTIVE 판본과 공유하는 항은 그 판본을 계속 가리킨 채 남는다.
   */
  async removeVersion(versionId: string): Promise<void> {
    const chunkIxs = await this.repository.listVersionChunkIxs(versionId);
    await this.repository.subtractVocabPostings(chunkIxs);
  }

  /**
   * 인메모리 스냅샷 폐기 — 갱신 트랜잭션이 **커밋된 뒤**에 부른다.
   * 트랜잭션 안에서 부르면 아직 커밋되지 않은 어휘를 스냅샷이 붙들 수 있고, 롤백되면
   * 존재하지 않는 포스팅을 캐시가 계속 내놓는다.
   */
  invalidate(): void {
    this.snapshot = null;
    this.loading = null;
  }

  /**
   * 전량 재생성 — 초기 백필·복구. 멱등이며 **`keyword_chunk_index`의 ix는 보존한다**.
   *
   * 전건 잡에는 못 쓴다: ACTIVE 7,154청크 생성이 로컬 20.3s(prod 환산 ~70s)인데 전건 잡은
   * 문서마다 `runOne`이라 87건 × 70s ≈ 100분이 된다. 그래서 증분 훅이 본 경로다.
   */
  async rebuildAll(): Promise<VocabRebuildResult> {
    const chunks = await this.repository.listActiveChunkContents();
    const ixByChunkId = await this.repository.assignChunkIxs(chunks.map((chunk) => chunk.id));
    const entries = postingsOf(chunks, ixByChunkId);

    await this.repository.replaceVocab(entries);
    this.invalidate();

    return {
      terms: entries.length,
      postings: entries.reduce((total, entry) => total + entry.chunkIxs.length, 0),
      chunks: chunks.length,
    };
  }

  /** 컷 = 비율 × 어휘가 덮는 청크 수. 어휘가 비면 0이고 모든 토큰의 DF 0이 이를 넘지 못한다 */
  private commonDfThreshold(corpusSize: number): number {
    return this.commonDfRatio * corpusSize;
  }

  /**
   * 컷 비율. 설정 주입 대신 여기서 읽는 이유는 이 서비스가 도메인 소유이기 때문이다 —
   * `retrieval.config`는 검색 설정의 단일 소유자이고, 값은 `RetrievalService`가 정책 문자열에
   * 싣는 것과 같아야 한다.
   */
  private get commonDfRatio(): number {
    const raw = process.env.RETRIEVAL_VOCAB_COMMON_DF_RATIO;
    if (raw === undefined || raw.trim() === '') return DEFAULT_COMMON_DF_RATIO;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_COMMON_DF_RATIO;
  }

  private load(): Promise<VocabSnapshot> {
    if (this.snapshot) return Promise.resolve(this.snapshot);
    if (this.loading) return this.loading;

    this.loading = this.readSnapshot()
      .then((snapshot) => {
        this.snapshot = snapshot;
        return snapshot;
      })
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  private async readSnapshot(): Promise<VocabSnapshot> {
    const [rows, index] = await Promise.all([
      this.repository.loadVocabTerms(),
      this.repository.loadChunkIndex(),
    ]);

    const chunkIdByIx: (string | undefined)[] = [];
    let markSize = 0;
    for (const entry of index) {
      chunkIdByIx[entry.ix] = entry.chunkId;
      if (entry.ix + 1 > markSize) markSize = entry.ix + 1;
    }

    const terms: string[] = [];
    const postings: Int32Array[] = [];
    const covered = new Set<number>();
    for (const row of rows) {
      terms.push(row.term);
      postings.push(Int32Array.from(row.chunkIxs));
      for (const ix of row.chunkIxs) {
        covered.add(ix);
        if (ix + 1 > markSize) markSize = ix + 1;
      }
    }

    return { terms, postings, chunkIdByIx, corpusSize: covered.size, markSize };
  }
}

/**
 * 청크 본문 → 항별 포스팅. **어절 산출은 SQL이 아니라 질의와 같은 토크나이저로 한다** —
 * 두 축이 갈리면 분류(DF)와 매칭(부분문자열)이 어긋나 #402의 순손해가 재현된다.
 */
function postingsOf(
  chunks: { id: string; content: string }[],
  ixByChunkId: Map<string, number>,
): { term: string; chunkIxs: number[] }[] {
  const byTerm = new Map<string, Set<number>>();
  for (const chunk of chunks) {
    const ix = ixByChunkId.get(chunk.id);
    if (ix === undefined) continue;
    for (const term of eojeolsOf(chunk.content)) {
      const postings = byTerm.get(term);
      if (postings) postings.add(ix);
      else byTerm.set(term, new Set([ix]));
    }
  }
  return [...byTerm].map(([term, chunkIxs]) => ({ term, chunkIxs: [...chunkIxs] }));
}
