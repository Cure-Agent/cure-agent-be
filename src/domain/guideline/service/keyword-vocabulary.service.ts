import { Injectable } from '@nestjs/common';
import { eojeolsOf, tokenize } from '../../../infrastructure/retrieval/query-tokenizer';
import { GuidelineRepository } from '../repository/guideline.repository';

/**
 * 흔함 라벨의 기준 비율 (docs/specs/48). **손잡이가 아니라 코드 상수다** —
 * `RETRIEVAL_VOCAB_COMMON_DF_RATIO`는 제거됐고 이 값은 env로 바뀌지 않는다.
 */
const COMMON_DF_REFERENCE_RATIO = 0.05;

/** 질의 토큰 1개의 DF 판정 결과 — spec 48 기준 3·5가 이 값을 직접 본다 */
export interface TokenSelection {
  /** 질의에서 잘린 토큰 (조사 절단 후) */
  token: string;
  /**
   * 부분문자열 DF — 이 토큰을 품은 어휘 항들의 **포스팅 합집합** 크기다.
   * 항별 `df`의 합이 아니다: 같은 청크가 여러 항에 걸쳐 겹세어지면 틀린다 (§45 기준 1).
   */
  df: number;
  /**
   * **후보 선택에 쓰이지 않는 관측 라벨이다** (docs/specs/48). §45에서는 이 값이 true면
   * 토큰을 통째로 버렸지만, BM25 예산은 흔한 토큰을 버리는 대신 IDF로 가중만 낮춘다 —
   * 남은 의미는 「§45의 5% 기준으로는 흔했다」뿐이며 `COMMON_DF_REFERENCE_RATIO`로 고정된다.
   */
  common: boolean;
}

/** `selectCandidates`의 결과 — `chunkIds`가 null이면 전량 스캔이다 (기준 9·10) */
export interface CandidateSelection {
  tokens: TokenSelection[];
  /** BM25 상위 `budget`의 청크 id. **후보 0건이면 null**로 접어 전량 스캔에 넘긴다 */
  chunkIds: string[] | null;
}

/**
 * 어휘에서 파생된 BM25 길이 정규화 값 (docs/specs/48 기준 21의 관측 지점).
 *
 * 점수는 후보 확정 즉시 버려지므로 파생값이 stale해도 **결과에 조용히만 나타난다** —
 * 그래서 어휘 갱신이 이 값들을 실제로 따라오는지 볼 수 있는 창을 따로 낸다.
 */
export interface VocabDerivedStats {
  /** 어휘가 덮는 청크 수 = BM25의 `N` (§45 정의 그대로) */
  corpusSize: number;
  /** 포스팅 총합 ÷ `corpusSize` = BM25의 `avgdl` */
  avgDocLen: number;
  /** chunk id → 그 청크를 가리키는 어휘 항의 수 = BM25의 `dl` */
  docLenByChunkId: Record<string, number>;
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
  /**
   * ix → 그 청크를 가리키는 어휘 항의 수 = BM25의 `dl` (docs/specs/48).
   * **포스팅에서 파생하므로 표를 안 건드린다** — 백필도 재빌드도 필요 없었던 이유다.
   * prod 평균 148.7이고 `markSize` 확정 뒤라야 배열 크기를 잡을 수 있다.
   */
  docLen: Int32Array;
  /** 포스팅 총합 ÷ `corpusSize` = BM25의 `avgdl`. 어휘가 비면 0이다 */
  avgDocLen: number;
}

/** BM25 상수 — 표준값이고 185문항으로 조정하면 과적합이다 (docs/specs/48 Out of scope) */
const BM25_K1 = 1.2;
const BM25_B = 0.75;

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
   * 토큰별 부분문자열 확장 → 전 토큰 BM25 → 상위 `budget` (docs/specs/48).
   *
   * **예산은 인자로 받는다** — 값의 소유자는 `retrieval.config`이고 `RetrievalService`가
   * 정책 문자열에 싣는 값과 **같은 값**이어야 한다. 여기서 env를 따로 읽으면 두 축이 갈린다.
   */
  async selectCandidates(
    query: string,
    budget: number,
  ): Promise<CandidateSelection> {
    const snapshot = await this.load();
    const tokens = tokenize(query);
    const threshold = this.commonDfThreshold(snapshot.corpusSize);

    // 표식은 호출마다 새로 잡는다 — 재사용하면 동시 질의가 서로의 표식을 덮어쓴다.
    // prod 규모에서도 셋을 합쳐 230KB라 할당 비용이 스캔 비용에 묻힌다.
    const tokenGeneration = new Int32Array(snapshot.markSize);
    const termFrequency = new Int32Array(snapshot.markSize);
    const score = new Float64Array(snapshot.markSize);
    const scored = new Uint8Array(snapshot.markSize);
    const scoredIxs: number[] = [];
    const selections: TokenSelection[] = [];

    tokens.forEach((token, stamp) => {
      // stamp를 토큰마다 올려 표식을 지우지 않고 재사용한다 (0은 미표식이라 +1)
      const generation = stamp + 1;
      const touched: number[] = [];
      let df = 0;

      for (let index = 0; index < snapshot.terms.length; index += 1) {
        if (!snapshot.terms[index].includes(token)) continue;
        for (const ix of snapshot.postings[index]) {
          // **tf는 출현 횟수가 아니라 어절형의 가짓수다** — `임상`이 한 청크에서
          // `임상적`·`임상질문`으로 나타나면 2이고, `임상적`만 10번 나와도 1이다.
          // 어휘가 항별 집합이라 여기서 셀 수 있는 것이 이것뿐이며, 이 근사가 통한다는
          // 근거는 185문항 실측이다(docs/specs/48 위험 ⑷).
          if (tokenGeneration[ix] === generation) {
            termFrequency[ix] += 1;
            continue;
          }
          tokenGeneration[ix] = generation;
          termFrequency[ix] = 1;
          touched.push(ix);
          df += 1;
        }
      }

      // `common`은 이제 관측 라벨이다 — 흔한 토큰도 아래 IDF 가중으로 증거에 참여한다
      selections.push({ token, df, common: df > threshold });
      // df가 0이면 IDF만 커지고 더할 tf가 없다. 어휘가 비어도 여기서 걸린다
      // (그래야 `avgDocLen`이 0인 채로 나눗셈에 닿지 않는다)
      if (df === 0) return;

      // 항상 양수라 흔한 토큰이 죽지 않고 작아지기만 한다
      const idf = Math.log(
        1 + (snapshot.corpusSize - df + 0.5) / (df + 0.5),
      );
      for (const ix of touched) {
        const tf = termFrequency[ix];
        const saturation =
          tf +
          BM25_K1 *
            (1 - BM25_B + (BM25_B * snapshot.docLen[ix]) / snapshot.avgDocLen);
        score[ix] += (idf * (tf * (BM25_K1 + 1))) / saturation;
        if (scored[ix] === 1) continue;
        scored[ix] = 1;
        scoredIxs.push(ix);
      }
    });

    // **점수는 여기서 버린다** — 순위는 원문 질의의 `word_similarity`가 매긴다.
    // 같은 30건을 회수해도 BM25 순서를 융합에 넘기면 융합 R@30이 0.995 → 0.989이고
    // 합집합 커버리지가 1.000 → 0.995로 깨진다(RRF가 점수를 안 보고 순위만 본다).
    const candidates: string[] = scoredIxs
      .map((ix) => ({ chunkId: snapshot.chunkIdByIx[ix], value: score[ix] }))
      .filter(
        (entry): entry is { chunkId: string; value: number } =>
          entry.chunkId !== undefined,
      )
      .sort((left, right) => right.value - left.value || compare(left.chunkId, right.chunkId))
      .slice(0, budget)
      .map((entry) => entry.chunkId);

    // 후보 0건은 arm을 통째로 죽이는 것이라 **느린 것보다 나쁘다** — 하이브리드가 벡터
    // 단독으로 조용히 퇴화한다. 질의 토큰이 코퍼스에 없는 신조어뿐이거나 어휘가 비었을 때
    // (백필 전 배포 창) 모두 여기로 온다.
    return {
      tokens: selections,
      chunkIds: candidates.length > 0 ? candidates : null,
    };
  }

  /**
   * 어휘 파생값 관측 (docs/specs/48 기준 21).
   *
   * 점수는 후보 확정 즉시 버려지므로 `dl`·`avgdl`이 stale해도 **결과에 조용히만** 나타난다.
   * 어휘 갱신이 이 값들을 실제로 따라오는지 볼 수 있는 유일한 창이다.
   */
  async derivedStats(): Promise<VocabDerivedStats> {
    const snapshot = await this.load();
    const docLenByChunkId: Record<string, number> = {};
    for (let ix = 0; ix < snapshot.docLen.length; ix += 1) {
      const length = snapshot.docLen[ix];
      if (length === 0) continue;
      const chunkId = snapshot.chunkIdByIx[ix];
      if (chunkId !== undefined) docLenByChunkId[chunkId] = length;
    }
    return {
      corpusSize: snapshot.corpusSize,
      avgDocLen: snapshot.avgDocLen,
      docLenByChunkId,
    };
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

  /**
   * 관측 라벨의 컷 = `COMMON_DF_REFERENCE_RATIO` × 어휘가 덮는 청크 수.
   * 어휘가 비면 0이고 모든 토큰의 DF 0이 이를 넘지 못한다.
   */
  private commonDfThreshold(corpusSize: number): number {
    return COMMON_DF_REFERENCE_RATIO * corpusSize;
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
    let totalPostings = 0;
    for (const row of rows) {
      terms.push(row.term);
      postings.push(Int32Array.from(row.chunkIxs));
      totalPostings += row.chunkIxs.length;
      for (const ix of row.chunkIxs) {
        covered.add(ix);
        if (ix + 1 > markSize) markSize = ix + 1;
      }
    }

    // `markSize`가 확정된 **뒤에야** 배열을 잡을 수 있어 포스팅을 한 번 더 돈다.
    // 위 루프에 합치면 `chunkIdByIx`에 없는 ix를 만나는 순간 배열이 짧아진다.
    const docLen = new Int32Array(markSize);
    for (const posting of postings) {
      for (const ix of posting) docLen[ix] += 1;
    }

    const corpusSize = covered.size;
    return {
      terms,
      postings,
      chunkIdByIx,
      corpusSize,
      markSize,
      docLen,
      // 어휘가 비면 0이지만 그때는 모든 토큰의 df도 0이라 나눗셈에 닿지 않는다
      avgDocLen: corpusSize > 0 ? totalPostings / corpusSize : 0,
    };
  }
}

/** 청크 id 오름차순 — 동점 절단의 결정성이 여기 하나에 걸려 있다 (기준 7) */
function compare(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
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
