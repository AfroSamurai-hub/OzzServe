import { buildServer } from './app.js';
import { validateConfig, config } from './config.js';

const start = async () => {
    try {
        validateConfig();
        const server = await buildServer();
        await server.listen({ port: config.port, host: '0.0.0.0' });
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
};

start();
