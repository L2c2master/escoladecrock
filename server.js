require('dotenv').config();

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3000;
const databaseUrl = process.env.DATABASE_URL;
const pool = databaseUrl ? new Pool({
  connectionString: databaseUrl,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
}) : null;

let memoryState = null;
const sessions = new Map();

app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use(express.static(__dirname));

function getSessionToken(req) {
  const cookies = String(req.headers.cookie || '').split(';');
  const sessionCookie = cookies.find(cookie => cookie.trim().startsWith('crock_session='));
  return sessionCookie ? decodeURIComponent(sessionCookie.split('=').slice(1).join('=')) : '';
}

function requireSession(req, res, next) {
  const session = sessions.get(getSessionToken(req));
  if (!session) return res.status(401).json({ error: 'Sessao nao autenticada.' });
  req.session = session;
  next();
}

async function readState() {
  if (!pool) return memoryState;
  const result = await pool.query('SELECT data FROM app_state WHERE id = 1');
  return result.rows[0]?.data || null;
}

async function writeState(data) {
  if (!pool) {
    memoryState = data;
    return;
  }
  await pool.query(`
    INSERT INTO app_state (id, data, updated_at)
    VALUES (1, $1::jsonb, NOW())
    ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
  `, [JSON.stringify(data)]);
}

function publicState(data) {
  if (!data) return null;
  return {
    ...data,
    funcionarios: data.funcionarios.map(({ senha, ...funcionario }) => funcionario)
  };
}

async function initializeDatabase() {
  if (!pool) {
    console.warn('DATABASE_URL ausente: usando memoria temporaria no ambiente local.');
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, database: Boolean(pool) });
});

app.post('/api/login', async (req, res) => {
  try {
    const data = await readState();
    const user = data?.funcionarios?.find(funcionario =>
      funcionario.login === String(req.body?.login || '').trim() &&
      funcionario.senha === String(req.body?.senha || '') &&
      funcionario.ativo
    );
    if (!user) return res.status(401).json({ error: 'Usuario ou senha incorretos.' });

    const token = crypto.randomUUID();
    const { senha, ...safeUser } = user;
    sessions.set(token, safeUser);
    res.setHeader('Set-Cookie', `crock_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
    res.json({ ok: true, user: safeUser });
  } catch (error) {
    console.error('Erro no login:', error);
    res.status(500).json({ error: 'Nao foi possivel entrar.' });
  }
});

app.post('/api/logout', requireSession, (req, res) => {
  sessions.delete(getSessionToken(req));
  res.setHeader('Set-Cookie', 'crock_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/state', requireSession, async (_req, res) => {
  try {
    res.json({ data: publicState(await readState()) });
  } catch (error) {
    console.error('Erro ao carregar estado:', error);
    res.status(500).json({ error: 'Nao foi possivel carregar os dados.' });
  }
});

app.put('/api/state', requireSession, async (req, res) => {
  const data = req.body;
  if (!data || !Array.isArray(data.funcionarios) || !Array.isArray(data.perguntas)) {
    return res.status(400).json({ error: 'Estado invalido.' });
  }

  try {
    const currentState = await readState();
    const currentById = new Map((currentState?.funcionarios || []).map(item => [Number(item.id), item]));
    const cleanState = {
      funcionarios: data.funcionarios.map(item => ({
        ...item,
        senha: item.senha || currentById.get(Number(item.id))?.senha || ''
      })),
      perguntas: data.perguntas,
      nextId: Number(data.nextId) || 1
    };
    await writeState(cleanState);
    res.json({ ok: true });
  } catch (error) {
    console.error('Erro ao salvar estado:', error);
    res.status(500).json({ error: 'Nao foi possivel salvar os dados.' });
  }
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'treinamento_crock.html'));
});

async function startServer(listenPort = port) {
  await initializeDatabase();
  return new Promise(resolve => {
    const server = app.listen(listenPort, '0.0.0.0', () => resolve(server));
  });
}

if (require.main === module) {
  startServer()
    .then(() => console.log(`Escola de Crock disponível na porta ${port}`))
    .catch(error => {
    console.error('Falha ao iniciar o banco:', error);
    process.exit(1);
    });
}

module.exports = { app, startServer };
