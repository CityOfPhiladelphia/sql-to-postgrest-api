import Fastify from 'fastify';
import { fetch } from 'undici';
import { processSql, renderHttp, UnsupportedError } from '@supabase/sql-to-rest';

const PORT = Number(process.env.PORT) || 3010;
const POSTGREST_ENDPOINT = process.env.POSTGREST_ENDPOINT || "http://localhost:3000"

const fastify = Fastify({
  logger: true // Gives you structured, maintainable logging out-of-the-box
});

// Headers that belong strictly to the proxy-to-upstream connection
const HOP_BY_HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'content-length',
  'proxy-authenticate', 'proxy-authorization', 'te', 'trailers', 'upgrade'
]);

// Health Check Route
fastify.get('/health', async (request, reply) => {
  return { msg: 'Running' };
});

// Query Proxy Route
fastify.get('/query', async (request, reply) => {
  // Fastify parses search parameters into request.query automatically
  const { sql } = request.query as { sql?: string };

  if (!sql) {
    reply.status(400);
    return { error: 'Missing required "sql" query parameter' };
  }

  try {
    // Convert SQL to PostgREST path
    const statement = await processSql(sql);
    const httpRequest = await renderHttp(statement);
    const targetUrl = `${POSTGREST_ENDPOINT}${httpRequest.fullPath}`;

    // Forward to PostgREST
    const response = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        'Accept': (request.headers['accept'] as string) || 'application/json',
        ...(request.headers['authorization'] && { 'Authorization': request.headers['authorization'] as string })
      }
    });

    // Forward status code
    reply.status(response.status);

    // Forward safe application headers
    for (const [key, value] of response.headers.entries()) {
      if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
        reply.header(key, value);
      }
    }

    // Stream the body safely. Fastify natively handles streams passed to reply.send()
    if (response.body) {
      return reply.send(response.body);
    }

    return reply.send();

  } catch (error: unknown) {
    if (error instanceof UnsupportedError) {
      reply.status(400);
      return { error: 'This query cannot be converted to PostgREST syntax', type: 'unsupported' };
    }

    // Let global error handler catch unexpected errors, or log and 500 here:
    request.log.error(error);
    reply.status(500);
    return { error: 'Internal Server Error' };
  }
});


// SQL to PostgREST Conversion Route
fastify.get('/convert', async (request, reply) => {
  const { sql } = request.query as { sql?: string };

  if (!sql) {
    reply.status(400);
    return { error: 'Missing required "sql" query parameter' };
  }

  try {
    // Convert SQL to PostgREST path
    const statement = await processSql(sql);
    const httpRequest = await renderHttp(statement);

    return { path: httpRequest.fullPath, fullPath: `${POSTGREST_ENDPOINT}${httpRequest.fullPath}` };
  } catch (error: unknown) {
    if (error instanceof UnsupportedError) {
      reply.status(400);
      return { error: 'This query cannot be converted to PostgREST syntax', type: 'unsupported' };
    }

    // Let global error handler catch unexpected errors, or log and 500 here:
    request.log.error(error);
    reply.status(500);
    return { error: 'Internal Server Error' };
  }
});

// Start Server & Graceful Shutdown
const start = async () => {
  try {
    fastify.log.info('Warming up SQL parser WASM module...');
    await processSql('SELECT 1').catch(() => { });
    fastify.log.info('SQL parser ready.');

    await fastify.listen({ port: PORT, host: '0.0.0.0' });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
