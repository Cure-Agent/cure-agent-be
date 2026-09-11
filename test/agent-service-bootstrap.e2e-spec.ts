// docs/specs/49 수용 기준 23~39 동결 테스트 — 구현 중 수정 금지
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request as requestHttps } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GenericContainer,
  Network,
  StartedNetwork,
  StartedTestContainer,
  Wait,
} from 'testcontainers';
import { parse } from 'yaml';

const REPOSITORY_ROOT = join(__dirname, '..');
const COMPOSE_PATH = join(REPOSITORY_ROOT, 'docker', 'gcp', 'compose.yml');
const NGINX_CONFIG_PATH = join(REPOSITORY_ROOT, 'nginx', 'conf.d', 'api.conf');
const CERTIFICATE_TARGET = '/etc/letsencrypt/live/api.cure.demo01.xyz/fullchain.pem';
const PRIVATE_KEY_TARGET = '/etc/letsencrypt/live/api.cure.demo01.xyz/privkey.pem';

const STUB_SERVER_SCRIPT = `
const http = require('http');
const name = process.env.STUB_NAME;
const port = Number(process.env.STUB_PORT);

http
  .createServer((req, res) => {
    req.on('end', () => {
      let cookieHeaderLines = 0;
      for (let index = 0; index < req.rawHeaders.length; index += 2) {
        if (req.rawHeaders[index].toLowerCase() === 'cookie') {
          cookieHeaderLines += 1;
        }
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          service: name,
          method: req.method,
          path: req.url,
          cookie: req.headers.cookie ?? null,
          cookieHeaderLines,
          csrf: req.headers['x-csrf-protection'] ?? null,
        }),
      );
    });
    req.resume();
  })
  .listen(port, '0.0.0.0', () => console.log('stub-ready:' + name));
`.trim();

interface TlsFiles {
  directory: string;
  certificatePath: string;
  privateKeyPath: string;
}

interface HttpsResponse {
  statusCode: number | undefined;
  body: string;
}

interface StubResponse {
  service: string;
  method: string;
  path: string;
  cookie: string | null;
  cookieHeaderLines: number;
  csrf: string | null;
}

interface PollObservation {
  statusCode: number | undefined;
  service: string | null;
  body: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label}이(가) 객체가 아니다`);
  }
  return value;
}

function readComposeServices(): Record<string, unknown> {
  const document: unknown = parse(readFileSync(COMPOSE_PATH, 'utf8'));
  return requireRecord(requireRecord(document, 'compose 문서').services, 'services');
}

function nginxImageFromCompose(): string {
  const nginx = requireRecord(readComposeServices().nginx, 'services.nginx');
  if (typeof nginx.image !== 'string' || nginx.image.length === 0) {
    throw new Error('services.nginx.image가 비어 있거나 문자열이 아니다');
  }
  return nginx.image;
}

function normalizeNameSet(value: unknown, label: string): Set<string> {
  if (value === undefined || value === null) {
    return new Set();
  }

  if (Array.isArray(value)) {
    const names = value.map((item, index) => {
      if (typeof item !== 'string') {
        throw new Error(`${label}[${index}]이(가) 문자열이 아니다`);
      }
      return item;
    });
    return new Set(names);
  }

  if (isRecord(value)) {
    return new Set(Object.keys(value));
  }

  throw new Error(`${label}이(가) 목록 또는 맵이 아니다`);
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
      const environmentValue = equalsIndex === -1 ? undefined : item.slice(equalsIndex + 1);
      if (key.length === 0) {
        throw new Error(`environment[${index}]의 키가 비어 있다`);
      }
      environment.set(key, environmentValue);
    }
    return environment;
  }

  if (isRecord(value)) {
    return new Map(Object.entries(value));
  }

  throw new Error('environment가 목록 또는 맵이 아니다');
}

function normalizeHealthcheckTest(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    const command = value.map((item, index) => {
      if (typeof item !== 'string') {
        throw new Error(`healthcheck.test[${index}]이(가) 문자열이 아니다`);
      }
      return item;
    });
    return command.join(' ');
  }

  throw new Error('healthcheck.test가 문자열 또는 배열이 아니다');
}

function createSelfSignedTlsFiles(): TlsFiles {
  const directory = mkdtempSync(join(tmpdir(), 'agent-edge-tls-'));
  const certificatePath = join(directory, 'fullchain.pem');
  const privateKeyPath = join(directory, 'privkey.pem');

  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-nodes',
        '-newkey',
        'rsa:2048',
        '-days',
        '1',
        '-keyout',
        privateKeyPath,
        '-out',
        certificatePath,
        '-subj',
        '/CN=api.cure.demo01.xyz',
      ],
      { stdio: 'ignore' },
    );
  } catch (error: unknown) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }

  return { directory, certificatePath, privateKeyPath };
}

async function startStub(
  network: StartedNetwork,
  name: 'app' | 'agent',
  port: 3000 | 8000,
): Promise<StartedTestContainer> {
  return new GenericContainer('node:22-alpine')
    .withCommand(['node', '-e', STUB_SERVER_SCRIPT])
    .withEnvironment({ STUB_NAME: name, STUB_PORT: String(port) })
    .withNetwork(network)
    .withNetworkAliases(name)
    .withWaitStrategy(Wait.forLogMessage(`stub-ready:${name}`))
    .withStartupTimeout(60_000)
    .start();
}

async function startNginx(
  network: StartedNetwork,
  tlsFiles: TlsFiles,
): Promise<StartedTestContainer> {
  return new GenericContainer(nginxImageFromCompose())
    .withNetwork(network)
    .withExposedPorts(443)
    .withBindMounts([
      {
        source: NGINX_CONFIG_PATH,
        target: '/etc/nginx/conf.d/default.conf',
        mode: 'ro',
      },
      { source: tlsFiles.certificatePath, target: CERTIFICATE_TARGET, mode: 'ro' },
      { source: tlsFiles.privateKeyPath, target: PRIVATE_KEY_TARGET, mode: 'ro' },
    ])
    .withStartupTimeout(60_000)
    .start();
}

function requireStartedContainer(
  container: StartedTestContainer | undefined,
  label: string,
): StartedTestContainer {
  if (!container) {
    throw new Error(`${label} 컨테이너가 기동하지 않았다`);
  }
  return container;
}

function requireStartedNetwork(network: StartedNetwork | undefined): StartedNetwork {
  if (!network) {
    throw new Error('테스트 네트워크가 기동하지 않았다');
  }
  return network;
}

function sendHttps(
  nginx: StartedTestContainer,
  input: {
    method: 'GET' | 'POST';
    path: string;
    headers?: Record<string, string>;
    timeoutMs?: number;
  },
): Promise<HttpsResponse> {
  return new Promise((resolve, reject) => {
    const request = requestHttps(
      {
        host: nginx.getHost(),
        port: nginx.getMappedPort(443),
        servername: 'api.cure.demo01.xyz',
        method: input.method,
        path: input.path,
        headers: {
          Host: 'api.cure.demo01.xyz',
          'User-Agent': 'cure-agent-acceptance-e2e',
          ...input.headers,
        },
        rejectUnauthorized: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => {
          resolve({
            statusCode: response.statusCode,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );

    request.setTimeout(input.timeoutMs ?? 15_000, () => {
      request.destroy(new Error(`HTTPS 요청 시간 초과: ${input.path}`));
    });
    request.on('error', reject);
    request.end();
  });
}

function parseStubResponse(response: HttpsResponse): StubResponse {
  const value: unknown = JSON.parse(response.body);
  if (!isRecord(value)) {
    throw new Error(`stub 응답이 객체가 아니다: ${response.body}`);
  }

  if (
    typeof value.service !== 'string' ||
    typeof value.method !== 'string' ||
    typeof value.path !== 'string' ||
    (value.cookie !== null && typeof value.cookie !== 'string') ||
    typeof value.cookieHeaderLines !== 'number' ||
    (value.csrf !== null && typeof value.csrf !== 'string')
  ) {
    throw new Error(`stub 응답 형식이 잘못됐다: ${response.body}`);
  }

  return {
    service: value.service,
    method: value.method,
    path: value.path,
    cookie: value.cookie,
    cookieHeaderLines: value.cookieHeaderLines,
    csrf: value.csrf,
  };
}

function serviceFromBody(body: string): string | null {
  try {
    const value: unknown = JSON.parse(body);
    return isRecord(value) && typeof value.service === 'string' ? value.service : null;
  } catch {
    return null;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe('docs/specs/49 — 운영 compose 불변식', () => {
  it('기준 34: agent 서비스는 cure-proxy 망에만 붙는다', () => {
    const services = readComposeServices();
    expect(services.agent).toBeDefined();

    const agent = requireRecord(services.agent, 'services.agent');
    const networks = normalizeNameSet(agent.networks, 'services.agent.networks');
    expect([...networks].sort()).toEqual(['cure-proxy']);
    expect(networks.has('cure-backend')).toBe(false);
  });

  it('기준 35: agent 환경에는 DATABASE_URL과 REDIS_URL이 없다', () => {
    const services = readComposeServices();
    expect(services.agent).toBeDefined();

    const agent = requireRecord(services.agent, 'services.agent');
    const environment = normalizeEnvironment(agent.environment);
    expect(environment.has('DATABASE_URL')).toBe(false);
    expect(environment.has('REDIS_URL')).toBe(false);
  });

  it('기준 36: agent의 BE_ORIGIN은 내부 app 주소다', () => {
    const services = readComposeServices();
    expect(services.agent).toBeDefined();

    const agent = requireRecord(services.agent, 'services.agent');
    const environment = normalizeEnvironment(agent.environment);
    expect(environment.get('BE_ORIGIN')).toBe('http://app:3000');
  });

  it('기준 37: agent 환경에는 운영 추적 활성화 키가 없다', () => {
    const services = readComposeServices();
    expect(services.agent).toBeDefined();

    const agent = requireRecord(services.agent, 'services.agent');
    const environment = normalizeEnvironment(agent.environment);
    const environmentKeys = [...environment.keys()];
    expect(environment.has('AGENT_TRACING_ENABLED')).toBe(false);
    expect(environmentKeys.filter((key) => key.startsWith('LANGSMITH_'))).toEqual([]);
    expect(environmentKeys.filter((key) => key.startsWith('LANGCHAIN_'))).toEqual([]);
  });

  it('기준 38: agent healthcheck는 agent healthz 경로를 본다', () => {
    const services = readComposeServices();
    expect(services.agent).toBeDefined();

    const agent = requireRecord(services.agent, 'services.agent');
    expect(agent.healthcheck).toBeDefined();
    const healthcheck = requireRecord(agent.healthcheck, 'services.agent.healthcheck');
    expect(normalizeHealthcheckTest(healthcheck.test)).toContain('/api/v1/agent/healthz');
  });

  it('기준 39: nginx depends_on에는 agent가 없다', () => {
    const services = readComposeServices();
    expect(services.agent).toBeDefined();

    const nginx = requireRecord(services.nginx, 'services.nginx');
    const dependencies = normalizeNameSet(nginx.depends_on, 'services.nginx.depends_on');
    expect(dependencies.has('agent')).toBe(false);
  });
});

describe('docs/specs/49 — agent가 있는 nginx 망', () => {
  let network: StartedNetwork | undefined;
  let app: StartedTestContainer | undefined;
  let agent: StartedTestContainer | undefined;
  let nginx: StartedTestContainer | undefined;
  let tlsFiles: TlsFiles | undefined;

  beforeAll(async () => {
    tlsFiles = createSelfSignedTlsFiles();
    const startedNetwork = await new Network().start();
    network = startedNetwork;
    app = await startStub(startedNetwork, 'app', 3000);
    agent = await startStub(startedNetwork, 'agent', 8000);
    nginx = await startNginx(startedNetwork, tlsFiles);
  });

  afterAll(async () => {
    try {
      await Promise.allSettled([nginx?.stop(), agent?.stop(), app?.stop()]);
      await network?.stop();
    } finally {
      if (tlsFiles) {
        rmSync(tlsFiles.directory, { recursive: true, force: true });
      }
    }
  });

  it('기준 23: /api/v1/agent/ 아래 요청은 경로를 보존해 agent에 도달한다', async () => {
    const runningNginx = requireStartedContainer(nginx, 'nginx');
    const healthPath = '/api/v1/agent/healthz';
    const healthResponse = await sendHttps(runningNginx, { method: 'GET', path: healthPath });
    expect(healthResponse.statusCode).toBe(200);
    const health = parseStubResponse(healthResponse);
    expect(health.service).toBe('agent');
    expect(health.path).toBe(healthPath);

    const mePath = '/api/v1/agent/me';
    const meResponse = await sendHttps(runningNginx, { method: 'GET', path: mePath });
    expect(meResponse.statusCode).toBe(200);
    const me = parseStubResponse(meResponse);
    expect(me.service).toBe('agent');
    expect(me.path).toBe(mePath);
  });

  it('기준 24: agent 외 일반 API와 auth refresh는 app에 도달한다', async () => {
    const runningNginx = requireStartedContainer(nginx, 'nginx');
    const generalResponse = await sendHttps(runningNginx, {
      method: 'GET',
      path: '/api/v1/patients',
    });
    expect(generalResponse.statusCode).toBe(200);
    expect(parseStubResponse(generalResponse).service).toBe('app');

    const refreshResponse = await sendHttps(runningNginx, {
      method: 'POST',
      path: '/api/v1/auth/refresh',
      headers: { 'X-CSRF-Protection': 'csrf-probe-24' },
    });
    expect(refreshResponse.statusCode).toBe(200);
    expect(parseStubResponse(refreshResponse).service).toBe('app');
  });

  it('기준 25: /api/v1/agentx/ 경로는 app에 도달한다', async () => {
    const response = await sendHttps(requireStartedContainer(nginx, 'nginx'), {
      method: 'GET',
      path: '/api/v1/agentx/y',
    });
    expect(response.statusCode).toBe(200);
    expect(parseStubResponse(response).service).toBe('app');
  });

  it('기준 26: agent에는 access_token Cookie 한 줄만 전달된다', async () => {
    const response = await sendHttps(requireStartedContainer(nginx, 'nginx'), {
      method: 'GET',
      path: '/api/v1/agent/me',
      headers: {
        Cookie: 'access_token=access-AAA; refresh_token=refresh-RRR; other=other-OOO',
      },
    });
    expect(response.statusCode).toBe(200);
    const received = parseStubResponse(response);
    expect(received.service).toBe('agent');
    expect(received.cookie).toBe('access_token=access-AAA');
    expect(received.cookieHeaderLines).toBe(1);
    expect(received.cookie ?? '').not.toContain('refresh-RRR');
    expect(received.cookie ?? '').not.toContain('refresh_token');
  });

  it('기준 27: refresh_token만 있으면 agent에는 Cookie 헤더가 없다', async () => {
    const response = await sendHttps(requireStartedContainer(nginx, 'nginx'), {
      method: 'GET',
      path: '/api/v1/agent/me',
      headers: { Cookie: 'refresh_token=refresh-RRR' },
    });
    expect(response.statusCode).toBe(200);
    const received = parseStubResponse(response);
    expect(received.service).toBe('agent');
    expect(received.cookie).toBeNull();
    expect(received.cookieHeaderLines).toBe(0);
  });

  it('기준 28: X-CSRF-Protection 값이 그대로 agent에 도달한다', async () => {
    const response = await sendHttps(requireStartedContainer(nginx, 'nginx'), {
      method: 'POST',
      path: '/api/v1/agent/me',
      headers: { 'X-CSRF-Protection': 'csrf-probe-28' },
    });
    expect(response.statusCode).toBe(200);
    const received = parseStubResponse(response);
    expect(received.service).toBe('agent');
    expect(received.csrf).toBe('csrf-probe-28');
  });

  it('기준 29: app의 auth refresh Cookie는 재작성되지 않는다', async () => {
    const sentCookie = 'access_token=access-AAA; refresh_token=refresh-RRR';
    const response = await sendHttps(requireStartedContainer(nginx, 'nginx'), {
      method: 'POST',
      path: '/api/v1/auth/refresh',
      headers: {
        Cookie: sentCookie,
        'X-CSRF-Protection': 'csrf-probe-29',
      },
    });
    expect(response.statusCode).toBe(200);
    const received = parseStubResponse(response);
    expect(received.service).toBe('app');
    expect(received.cookie).toBe(sentCookie);
  });
});

describe('docs/specs/49 — agent가 없는 nginx 망', () => {
  let network: StartedNetwork | undefined;
  let app: StartedTestContainer | undefined;
  let lateAgent: StartedTestContainer | undefined;
  let nginx: StartedTestContainer | undefined;
  let tlsFiles: TlsFiles | undefined;

  beforeAll(async () => {
    tlsFiles = createSelfSignedTlsFiles();
    const startedNetwork = await new Network().start();
    network = startedNetwork;
    app = await startStub(startedNetwork, 'app', 3000);
    nginx = await startNginx(startedNetwork, tlsFiles);
  });

  afterAll(async () => {
    try {
      await Promise.allSettled([nginx?.stop(), lateAgent?.stop(), app?.stop()]);
      await network?.stop();
    } finally {
      if (tlsFiles) {
        rmSync(tlsFiles.directory, { recursive: true, force: true });
      }
    }
  });

  // 의도적 순서 의존: 30~32는 agent 부재 상태이고, 기준 33에서만 같은 망에 agent를 띄운다.
  it('기준 30: agent가 없는 망에서도 nginx가 기동하고 요청에 응답한다', async () => {
    expect(nginx).toBeDefined();
    const response = await sendHttps(requireStartedContainer(nginx, 'nginx'), {
      method: 'GET',
      path: '/nginx-startup-probe',
    });
    expect(response.statusCode).toBeDefined();
  });

  it('기준 31: agent가 없는 상태에서도 일반 API는 app이 응답한다', async () => {
    const response = await sendHttps(requireStartedContainer(nginx, 'nginx'), {
      method: 'GET',
      path: '/api/v1/patients',
    });
    expect(response.statusCode).toBe(200);
    expect(parseStubResponse(response).service).toBe('app');
  });

  it('기준 32: agent가 없는 상태의 agent 경로는 502다', async () => {
    const response = await sendHttps(requireStartedContainer(nginx, 'nginx'), {
      method: 'GET',
      path: '/api/v1/agent/healthz',
    });
    expect(response.statusCode).toBe(502);
  });

  it('기준 33: agent가 나중에 뜨면 nginx 재시작 없이 agent 경로가 복구된다', async () => {
    const runningNginx = requireStartedContainer(nginx, 'nginx');
    lateAgent = await startStub(requireStartedNetwork(network), 'agent', 8000);

    const deadline = Date.now() + 60_000;
    let lastObservation: PollObservation = {
      statusCode: undefined,
      service: null,
      body: '아직 요청하지 않음',
    };

    while (Date.now() < deadline) {
      const remainingMilliseconds = deadline - Date.now();
      try {
        const response = await sendHttps(runningNginx, {
          method: 'GET',
          path: '/api/v1/agent/healthz',
          timeoutMs: Math.max(1, Math.min(2_000, remainingMilliseconds)),
        });
        lastObservation = {
          statusCode: response.statusCode,
          service: serviceFromBody(response.body),
          body: response.body,
        };
      } catch (error: unknown) {
        lastObservation = {
          statusCode: undefined,
          service: null,
          body: error instanceof Error ? error.message : String(error),
        };
      }

      if (lastObservation.service === 'agent') {
        break;
      }

      if (deadline - Date.now() < 250) {
        break;
      }
      await delay(250);
    }

    expect(lastObservation).toEqual(
      expect.objectContaining({ statusCode: 200, service: 'agent' }),
    );
  });
});
