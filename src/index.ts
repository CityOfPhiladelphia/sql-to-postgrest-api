import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import { fetch } from 'undici';
import { processSql, renderHttp, UnsupportedError } from '@supabase/sql-to-rest';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';

const PORT = Number(process.env.PORT) || 3010;
const POSTGREST_ENDPOINT = process.env.POSTGREST_ENDPOINT || "http://localhost:3000"
const SERVER_URL = process.env.SERVER_URL || "http://localhost:3010"

const fastify = Fastify({
  logger: true // Gives you structured, maintainable logging out-of-the-box
});

// Headers that belong strictly to the proxy-to-upstream connection
const HOP_BY_HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'content-length',
  'proxy-authenticate', 'proxy-authorization', 'te', 'trailers', 'upgrade'
]);

await fastify.register(fastifySwagger, {
  openapi: {
    info: {
      title: 'SQL-to-PostgREST Proxy API',
      description: 'Dynamically converts and proxies raw SQL queries over to PostgREST endpoints.',
      version: '1.0.0'
    },
    servers: [{ url: SERVER_URL }]
  }
});

await fastify.register(fastifySwaggerUi, {
  routePrefix: '/docs',
  uiConfig: {
    docExpansion: 'full',
    deepLinking: false
  }
});

// Health Check Route
fastify.get('/health', {
  schema: {
    description: 'Check the health status of the proxy server',
    tags: ['System'],
    response: {
      200: {
        type: 'object',
        properties: {
          msg: { type: 'string', example: 'Running' }
        }
      }
    }
  }
}, async (request: FastifyRequest, reply: FastifyReply) => {
  return { msg: 'Running' };
});

fastify.get('/', {
  schema: {
    description: 'Redirects to /docs',
    tags: ['System'],
    response: {
      302: {
        type: 'null',
      }
    }
  }
}, async (request: FastifyRequest, reply: FastifyReply) => {
  return reply.redirect('/docs')
});

// Query Proxy Route
fastify.get('/query', {
  schema: {
    description: 'Converts SQL into PostGRest format, execute it against the upstream PostgREST service, and streams back the response.',
    tags: ['Query Engine'],
    querystring: {
      type: 'object',
      required: ['sql'],
      properties: {
        sql: { type: 'string', description: 'The raw SQL query statement to parse and run', examples: ['SELECT * FROM ppd_complaints limit 1'] }
      }
    },
    response: {
      400: {
        type: 'object',
        properties: {
          error: { type: 'string' },
          type: { type: 'string' }
        }
      },
      500: {
        type: 'object',
        properties: {
          error: { type: 'string' }
        }
      }
    }
  }
}, async (request: FastifyRequest, reply: FastifyReply) => {
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
fastify.get('/convert', {
  schema: {
    description: 'Dry-run transformation endpoint. Accepts a SQL string and exposes what the mapped PostgREST path will look like.',
    tags: ['Query Engine'],
    querystring: {
      type: 'object',
      required: ['sql'],
      properties: {
        sql: { type: 'string', description: 'The raw SQL query statement to translate', examples: ['SELECT * FROM ppd_complaints limit 1'] }
      }
    },
    response: {
      200: {
        type: 'object',
        properties: {
          path: { type: 'string', example: '/ppd_complaints?limit=1' }
        }
      },
      400: {
        type: 'object',
        properties: {
          error: { type: 'string' },
          type: { type: 'string' }
        }
      },
      500: {
        type: 'object',
        properties: {
          error: { type: 'string' }
        }
      }
    }
  }
}, async (request: FastifyRequest, reply: FastifyReply) => {
  const { sql } = request.query as { sql?: string };

  if (!sql) {
    reply.status(400);
    return { error: 'Missing required "sql" query parameter' };
  }

  try {
    // Convert SQL to PostgREST path
    const statement = await processSql(sql);
    const httpRequest = await renderHttp(statement);

    return { path: httpRequest.fullPath };
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
    // Force routes to build completely
    await fastify.ready();

    // Trigger true WASM compilation tax during boot sequence
    fastify.log.info('Warming up SQL parser WASM module via route injection...');
    await fastify.inject({
      method: 'GET',
      url: '/convert',
      query: { sql: 'SELECT 1' }
    });
    fastify.log.info('SQL parser ready and warmed up.');

    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    fastify.log.info(`Swagger UI live at: ${SERVER_URL}/docs`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
