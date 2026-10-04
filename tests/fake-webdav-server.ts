import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

/**
 * A deliberately small WebDAV server used by the sync tests. It implements just
 * enough of RFC 4918 for the app's transport: PROPFIND, MKCOL, GET, PUT,
 * DELETE, OPTIONS, ETags and If-Match / If-None-Match.
 */

export interface StoredFile {
  body: string;
  etag: string;
  contentType: string;
}

export interface FakeWebDav {
  url: string;
  files: Map<string, StoredFile>;
  collections: Set<string>;
  requests: Array<{ method: string; path: string }>;
  close(): Promise<void>;
}

function etagFor(counter: number): string {
  return `"v${counter}"`;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function startFakeWebDav(base = '/dav/cigen/'): Promise<FakeWebDav> {
  const files = new Map<string, StoredFile>();
  const collections = new Set<string>([base]);
  const requests: Array<{ method: string; path: string }> = [];
  let counter = 0;

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const rawUrl = req.url ?? '/';
    const path = decodeURIComponent(rawUrl.split('?')[0]);
    requests.push({ method: req.method ?? 'GET', path });

    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      handle(req, res, path, body);
    });
  });

  function jsonResponse(res: ServerResponse, status: number, payload: unknown): void {
    const text = JSON.stringify(payload);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(text);
  }

  function handle(req: IncomingMessage, res: ServerResponse, path: string, body: string): void {
    const method = (req.method ?? 'GET').toUpperCase();

    switch (method) {
      case 'OPTIONS':
        res.writeHead(200, {
          Allow: 'OPTIONS, PROPFIND, GET, PUT, DELETE, MKCOL',
          DAV: '1',
        });
        res.end();
        return;

      case 'PROPFIND': {
        const depth = String(req.headers.depth ?? '1');
        if (!collections.has(path)) {
          res.writeHead(404);
          res.end('not found');
          return;
        }
        const children: string[] = [];
        if (depth !== '0') {
          for (const key of files.keys()) {
            if (key.startsWith(path) && !key.slice(path.length).includes('/')) {
              children.push(key);
            }
          }
          for (const key of collections) {
            if (key !== path && key.startsWith(path) && !key.slice(path.length, -1).includes('/')) {
              children.push(key);
            }
          }
        }

        const entries = [path, ...children]
          .map((entry) => {
            const isCollection = entry.endsWith('/');
            const stored = files.get(entry);
            return `  <d:response>
    <d:href>${escapeXml(entry)}</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype>${isCollection ? '<d:collection/>' : ''}</d:resourcetype>
        ${stored ? `<d:getetag>${escapeXml(stored.etag)}</d:getetag>` : ''}
        ${stored ? `<d:getcontenttype>${escapeXml(stored.contentType)}</d:getcontenttype>` : ''}
        ${stored ? `<d:getcontentlength>${stored.body.length}</d:getcontentlength>` : ''}
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>`;
          })
          .join('\n');

        const xml = `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:">
${entries}
</d:multistatus>`;
        res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
        res.end(xml);
        return;
      }

      case 'MKCOL': {
        if (files.has(path)) {
          res.writeHead(405);
          res.end();
          return;
        }
        collections.add(path.endsWith('/') ? path : `${path}/`);
        res.writeHead(201);
        res.end();
        return;
      }

      case 'GET': {
        const stored = files.get(path);
        if (!stored) {
          res.writeHead(404);
          res.end('not found');
          return;
        }
        if (req.headers['if-none-match'] === stored.etag) {
          res.writeHead(304, { ETag: stored.etag });
          res.end();
          return;
        }
        res.writeHead(200, { ETag: stored.etag, 'Content-Type': stored.contentType });
        res.end(stored.body);
        return;
      }

      case 'PUT': {
        const existing = files.get(path);
        const ifMatch = req.headers['if-match'];
        const ifNoneMatch = req.headers['if-none-match'];

        if (ifNoneMatch === '*' && existing) {
          res.writeHead(412, { ETag: existing.etag });
          res.end();
          return;
        }
        if (typeof ifMatch === 'string' && ifMatch !== '*' && existing && ifMatch !== existing.etag) {
          res.writeHead(412, { ETag: existing?.etag ?? '' });
          res.end();
          return;
        }

        const parent = path.replace(/[^/]+\/?$/, '');
        if (parent && !collections.has(parent)) {
          res.writeHead(409);
          res.end('parent collection missing');
          return;
        }

        counter += 1;
        const etag = etagFor(counter);
        files.set(path, {
          body,
          etag,
          contentType: String(req.headers['content-type'] ?? 'application/octet-stream'),
        });
        res.writeHead(existing ? 200 : 201, { ETag: etag });
        res.end();
        return;
      }

      case 'DELETE': {
        const existing = files.get(path);
        if (!existing) {
          res.writeHead(404);
          res.end();
          return;
        }
        const ifMatch = req.headers['if-match'];
        if (typeof ifMatch === 'string' && ifMatch !== '*' && ifMatch !== existing.etag) {
          res.writeHead(412, { ETag: existing.etag });
          res.end();
          return;
        }
        files.delete(path);
        res.writeHead(204);
        res.end();
        return;
      }

      default:
        jsonResponse(res, 405, { error: `unsupported method ${method}` });
    }
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}${base}`,
    files,
    collections,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
