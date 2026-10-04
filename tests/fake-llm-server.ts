import { createServer, type Server } from 'node:http';

/**
 * Tiny OpenAI-compatible endpoint + DeepSeek share endpoint used to smoke test
 * the import script without touching the network.
 */

export interface RecordedCall {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

export interface FakeDeepSeek {
  url: string;
  calls: RecordedCall[];
  payload: unknown;
  close(): Promise<void>;
}

export interface FakeLlm {
  url: string;
  calls: RecordedCall[];
  /** Response for the next chat completion call. */
  reply: () => unknown;
  close(): Promise<void>;
}

function readBody(chunks: Buffer[]): unknown {
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return typeof address === 'object' && address ? address.port : 0;
}

export function sampleSharePayload(): unknown {
  return {
    code: 0,
    msg: '',
    data: {
      biz_code: 0,
      biz_msg: '',
      biz_data: {
        title: '词根拆解测试',
        model_type: 'default',
        messages: [
          {
            message_id: 1,
            role: 'USER',
            status: 'FINISHED',
            fragments: [{ id: 1, type: 'REQUEST', content: '拆解 resolution 和 compatible' }],
          },
          {
            message_id: 2,
            role: 'ASSISTANT',
            status: 'FINISHED',
            fragments: [
              { id: 1, type: 'THINK', content: '（思考过程，不应被抽取）' },
              {
                id: 2,
                type: 'RESPONSE',
                content:
                  '**resolution = re- + solut- + -ion**\n\n| 单词 | 拆解 |\n|---|---|\n| compatible | com- + pat- + -ible |',
              },
            ],
          },
        ],
      },
    },
  };
}

export async function startFakeDeepSeek(): Promise<FakeDeepSeek> {
  const calls: RecordedCall[] = [];
  const payload = sampleSharePayload();
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      calls.push({ path: req.url ?? '', headers: req.headers, body: readBody(chunks) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  const port = await listen(server);

  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    payload,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export async function startFakeLlm(
  extract: (request: unknown) => unknown,
): Promise<FakeLlm> {
  const calls: RecordedCall[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = readBody(chunks);
      calls.push({ path: req.url ?? '', headers: req.headers, body });
      const content = JSON.stringify(extract(body));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          model: 'fake-model',
          choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
        }),
      );
    });
  });
  const port = await listen(server);

  return {
    url: `http://127.0.0.1:${port}/v1`,
    calls,
    reply: () => extract(calls.at(-1)?.body as unknown),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Stand-in for a real extraction answer. */
export function fakeExtraction(): unknown {
  return {
    entries: [
      {
        word: 'resolution',
        meaning: '解决；分辨率',
        decomposition: 're- + solut- + -ion',
        components: [
          { morpheme: 're-', hint: '回、再' },
          { morpheme: 'solut-', hint: '松开、解开' },
          { morpheme: 'ion', hint: '名词后缀' },
        ],
      },
      {
        word: 'compatible',
        meaning: '兼容的',
        decomposition: 'com- + pat- + -ible',
        components: [
          { morpheme: 'com-', hint: '一起' },
          { morpheme: 'pat-', hint: '忍受、感受' },
          { morpheme: '-ible', hint: '可…的' },
        ],
      },
      // Invalid records that must be dropped by the validator.
      { word: 'is', decomposition: '不拆' },
      { word: '!!!', decomposition: 'x + y' },
      { word: 'whatever', decomposition: 'not-splittable' },
    ],
  };
}
