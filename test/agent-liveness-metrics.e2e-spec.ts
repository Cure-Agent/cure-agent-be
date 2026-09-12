// docs/specs/50 수용 기준 12~18 동결 테스트 — 운영 설정 원본을 파싱한다.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const REPOSITORY_ROOT = join(__dirname, '..');
const COMPOSE_PATH = join(REPOSITORY_ROOT, 'docker', 'gcp', 'compose.yml');
const ALLOY_PATH = join(
  REPOSITORY_ROOT,
  'docker',
  'gcp',
  'monitoring',
  'alloy',
  'config.alloy',
);
const ALERTS_PATH = join(
  REPOSITORY_ROOT,
  'docker',
  'gcp',
  'monitoring',
  'prometheus',
  'rules',
  'alerts.yml',
);

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label}이(가) 객체가 아니다`);
  }
  return value as Record<string, unknown>;
}

function requireList(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label}이(가) 목록이 아니다`);
  }
  return value;
}

function assertCriterion(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function readService(name: string): Record<string, unknown> {
  const document: unknown = parse(readFileSync(COMPOSE_PATH, 'utf8'));
  const services = requireRecord(requireRecord(document, 'compose 문서').services, 'services');
  return requireRecord(services[name], `services.${name}`);
}

function normalizeNameSet(value: unknown, label: string): Set<string> {
  if (value === undefined || value === null) {
    return new Set();
  }
  if (Array.isArray(value)) {
    return new Set(
      value.map((item: unknown, index: number) => {
        if (typeof item !== 'string') {
          throw new Error(`${label}[${index}]이(가) 문자열이 아니다`);
        }
        return item;
      }),
    );
  }
  return new Set(Object.keys(requireRecord(value, label)));
}

function normalizeEnvironment(value: unknown): Map<string, unknown> {
  if (value === undefined || value === null) {
    return new Map();
  }
  if (Array.isArray(value)) {
    const environment = new Map<string, unknown>();
    for (const [index, item] of value.entries()) {
      if (typeof item !== 'string') {
        throw new Error(`environment[${index}]이(가) 문자열이 아니다`);
      }
      const equalsIndex = item.indexOf('=');
      const key = equalsIndex === -1 ? item : item.slice(0, equalsIndex);
      if (key.length === 0) {
        throw new Error(`environment[${index}]의 키가 비어 있다`);
      }
      environment.set(key, equalsIndex === -1 ? undefined : item.slice(equalsIndex + 1));
    }
    return environment;
  }
  return new Map(Object.entries(requireRecord(value, 'environment')));
}

type RiverNode =
  | { kind: 'word' | 'string' | 'symbol'; value: string }
  | { kind: 'group'; value: string; children: RiverNode[] };

// 필요한 River 부분집합: 문자열/주석을 먼저 분리하고 괄호를 트리로 묶는다.
// 중첩 맵의 속성을 scrape 블록 속성으로 오인하거나 주석을 대상으로 세지 않는다.
function parseRiver(source: string): RiverNode[] {
  const tokens: RiverNode[] = [];
  const pattern = /\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|`[^`]*`|[A-Za-z_][A-Za-z_0-9.]*|[^\s]/g;
  for (const match of source.matchAll(pattern)) {
    const raw = match[0];
    if (/^\s/.test(raw) || raw.startsWith('//') || raw.startsWith('/*')) {
      continue;
    }
    if (raw.startsWith('"')) {
      const decoded: unknown = JSON.parse(raw);
      if (typeof decoded !== 'string') {
        throw new Error('River 문자열이 올바르지 않다');
      }
      tokens.push({ kind: 'string', value: decoded });
    } else if (raw.startsWith('`')) {
      tokens.push({ kind: 'string', value: raw.slice(1, -1) });
    } else {
      tokens.push({ kind: /^[A-Za-z_]/.test(raw) ? 'word' : 'symbol', value: raw });
    }
  }

  let cursor = 0;
  const closers: Record<string, string> = { '{': '}', '[': ']', '(': ')' };
  function readScope(closing?: string): RiverNode[] {
    const nodes: RiverNode[] = [];
    while (cursor < tokens.length) {
      const token = tokens[cursor++];
      if (!token) {
        throw new Error('River 토큰이 없다');
      }
      if (token.kind === 'symbol' && ['}', ']', ')'].includes(token.value)) {
        if (token.value !== closing) {
          throw new Error('River 닫는 괄호가 짝에 맞지 않는다');
        }
        return nodes;
      }
      const closer = token.kind === 'symbol' ? closers[token.value] : undefined;
      if (closer) {
        nodes.push({ kind: 'group', value: token.value, children: readScope(closer) });
      } else {
        nodes.push(token);
      }
    }
    if (closing) {
      throw new Error('River 블록의 닫는 괄호가 없다');
    }
    return nodes;
  }
  return readScope();
}

function attribute(nodes: RiverNode[], name: string): RiverNode | undefined {
  const index = nodes.findIndex(
    (node, position) =>
      (node.kind === 'word' || node.kind === 'string') &&
      node.value === name &&
      nodes[position + 1]?.kind === 'symbol' &&
      nodes[position + 1]?.value === '=',
  );
  return index === -1 ? undefined : nodes[index + 2];
}

function stringAttribute(nodes: RiverNode[], name: string): string | undefined {
  const value = attribute(nodes, name);
  return value?.kind === 'string' ? value.value : undefined;
}

interface AgentScrapeTarget {
  block: RiverNode[];
  target: RiverNode[];
}

function findAgentScrapeTarget(): AgentScrapeTarget | undefined {
  const nodes = parseRiver(readFileSync(ALLOY_PATH, 'utf8'));
  for (const [index, node] of nodes.entries()) {
    if (node.kind !== 'word' || node.value !== 'prometheus.scrape') {
      continue;
    }
    const label = nodes[index + 1];
    const block = nodes[index + 2];
    if (label?.kind !== 'string' || block?.kind !== 'group' || block.value !== '{') {
      throw new Error('prometheus.scrape 블록 형식이 올바르지 않다');
    }
    const targets = attribute(block.children, 'targets');
    if (targets?.kind !== 'group' || targets.value !== '[') {
      continue;
    }
    for (const target of targets.children) {
      if (
        target.kind === 'group' &&
        target.value === '{' &&
        stringAttribute(target.children, '__address__') === 'agent:8000'
      ) {
        return { block: block.children, target: target.children };
      }
    }
  }
  return undefined;
}

function findInstanceDown(): Record<string, unknown> | undefined {
  const document: unknown = parse(readFileSync(ALERTS_PATH, 'utf8'));
  const groups = requireList(requireRecord(document, 'alerts 문서').groups, 'groups');
  for (const group of groups) {
    const rules = requireList(requireRecord(group, '알림 그룹').rules, 'rules');
    for (const value of rules) {
      const rule = requireRecord(value, '알림 규칙');
      if (rule.alert === 'InstanceDown') {
        return rule;
      }
    }
  }
  return undefined;
}

describe('docs/specs/50 — 에이전트 생존 관측 운영 설정', () => {
  it('기준 12: alloy가 cure-proxy 망에 붙는다', () => {
    const networks = normalizeNameSet(readService('alloy').networks, 'alloy.networks');
    assertCriterion(networks.has('cure-proxy'), 'alloy가 cure-proxy 망에 붙어 있지 않다');
  });

  it('기준 13: alloy가 기존 수집 망에도 계속 붙는다', () => {
    const networks = normalizeNameSet(readService('alloy').networks, 'alloy.networks');
    assertCriterion(
      networks.has('cure-monitoring'),
      'alloy가 cure-monitoring 망에 붙어 있지 않다',
    );
    assertCriterion(networks.has('cure-backend'), 'alloy가 cure-backend 망에 붙어 있지 않다');
  });

  it('기준 14: agent는 여전히 cure-proxy 망에만 붙는다', () => {
    const networks = normalizeNameSet(readService('agent').networks, 'agent.networks');
    assertCriterion(
      networks.size === 1 && networks.has('cure-proxy'),
      'agent의 망이 정확히 [cure-proxy]가 아니다',
    );
  });

  it('기준 15: agent 환경에 DATABASE_URL과 REDIS_URL이 없다', () => {
    const environment = normalizeEnvironment(readService('agent').environment);
    assertCriterion(!environment.has('DATABASE_URL'), 'agent 환경에 DATABASE_URL 키가 있다');
    assertCriterion(!environment.has('REDIS_URL'), 'agent 환경에 REDIS_URL 키가 있다');
  });

  it('기준 16: agent:8000 대상이 있는 scrape 블록의 metrics_path가 /metrics다', () => {
    const matched = findAgentScrapeTarget();
    assertCriterion(matched !== undefined, 'agent:8000 타겟을 가진 scrape 블록이 없다');
    assertCriterion(
      stringAttribute(matched?.block ?? [], 'metrics_path') === '/metrics',
      'agent:8000 타겟이 속한 scrape 블록의 metrics_path가 /metrics가 아니다',
    );
  });

  it('기준 17: agent:8000 대상의 instance와 job 라벨이 cure-agent다', () => {
    const target = findAgentScrapeTarget()?.target ?? [];
    assertCriterion(
      stringAttribute(target, 'instance') === 'cure-agent',
      'agent:8000 대상의 instance 라벨이 cure-agent가 아니다 (대상 부재 포함)',
    );
    assertCriterion(
      stringAttribute(target, 'job') === 'cure-agent',
      'agent:8000 대상의 job 라벨이 cure-agent가 아니다 (대상 부재 포함)',
    );
  });

  it('기준 18: InstanceDown은 라벨 셀렉터 없이 up == 0으로 모든 대상을 덮는다', () => {
    const rule = findInstanceDown();
    assertCriterion(rule !== undefined, 'InstanceDown 알림 규칙이 없다');
    assertCriterion(
      typeof rule?.expr === 'string' && /^\s*up\s*==\s*0\s*$/.test(rule.expr),
      'InstanceDown 식이 라벨 셀렉터 없는 up == 0 형태가 아니다',
    );
  });
});
