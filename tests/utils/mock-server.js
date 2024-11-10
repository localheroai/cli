import http from 'http';

export function createMockServer(handlers = {}) {
    const server = http.createServer((req, res) => {
        const handler = handlers[`${req.method} ${req.url}`];

        if (!handler) {
            res.writeHead(404);
            res.end(JSON.stringify({ errors: ['Not found'] }));
            return;
        }

        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            const requestData = body ? JSON.parse(body) : {};
            handler(req, res, requestData);
        });
    });

    return new Promise((resolve) => {
        server.listen(0, () => {
            const port = server.address().port;
            resolve({
                port,
                url: `http://localhost:${port}`,
                close: () => new Promise(resolve => server.close(resolve))
            });
        });
    });
} 