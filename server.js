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

function createInitialState() {
  return {
    funcionarios: [
      { id: 1, nome: 'Ana Silva', login: 'ana', senha: '123', empresa: 'Biodents', funcao: 'Secretária', ativo: true },
      { id: 2, nome: 'Carla Mendes', login: 'carla', senha: '123', empresa: 'Master Odonto', funcao: 'Secretária', ativo: true },
      { id: 3, nome: 'Beatriz Lima', login: 'bea', senha: '123', empresa: 'LC Odontologia', funcao: 'Secretária', ativo: true },
      { id: 4, nome: 'Diego Ramos', login: 'diego', senha: '123', empresa: 'Biodents', funcao: 'Secretária', ativo: false },
      { id: 99, nome: 'Admin', login: 'admin', senha: 'admin', empresa: 'LC Odontologia', funcao: 'Administrador', ativo: true }
    ],
    perguntas: [
      { id: 1, autor: 'Ana Silva', empresa: 'Biodents', pergunta: 'Qual o preço para extrair siso?', resposta: 'Depende da situação do siso. Precisamos de uma consulta para confirmar.', nota: 4, status: 'analisado' },
      { id: 2, autor: 'Ana Silva', empresa: 'Biodents', pergunta: 'Quanto tempo dura um aparelho fixo?', resposta: 'Em média de 1 a 3 anos, dependendo de cada caso. O dentista avalia na consulta.', nota: 5, status: 'analisado' },
      { id: 3, autor: 'Ana Silva', empresa: 'Biodents', pergunta: 'A clínica atende plano Hapvida?', resposta: 'Sim! Atendemos Hapvida. Pode agendar pelo WhatsApp.', nota: 5, status: 'analisado' },
      { id: 4, autor: 'Carla Mendes', empresa: 'Master Odonto', pergunta: 'Clareamento dental machuca?', resposta: 'Em alguns casos pode causar sensibilidade temporária. O dentista vai orientar na consulta.', nota: 5, status: 'analisado' },
      { id: 5, autor: 'Carla Mendes', empresa: 'Master Odonto', pergunta: 'Quanto custa uma lente de contato dental?', resposta: 'O valor varia por caso. Agendamos uma avaliação gratuita para orçamento.', nota: 3, status: 'analisado' },
      { id: 6, autor: 'Beatriz Lima', empresa: 'LC Odontologia', pergunta: 'Atende criança com plano?', resposta: 'Sim, atendemos crianças. Verifique quais planos são aceitos com nossa secretaria.', nota: 4, status: 'analisado' },
      { id: 7, autor: 'Ana Silva', empresa: 'Biodents', pergunta: 'Tem estacionamento na clínica?', resposta: 'Temos vagas conveniadas no estacionamento ao lado. Informe que vai para a clínica.', nota: 2, status: 'analisado' },
      { id: 8, autor: 'Ana Silva', empresa: 'Biodents', pergunta: 'Preciso de encaminhamento para consulta?', resposta: 'Não precisa de encaminhamento. Pode agendar diretamente pelo WhatsApp.', nota: 5, status: 'analisado' },
      { id: 9, autor: 'Carla Mendes', empresa: 'Master Odonto', pergunta: 'Fazem implante dentário?', resposta: 'Sim! Trabalhamos com implantes. Agende uma avaliação para saber mais.', nota: 0, status: 'aguardando' },
      { id: 10, autor: 'Beatriz Lima', empresa: 'LC Odontologia', pergunta: 'Qual o horário de atendimento?', resposta: 'Atendemos de segunda a sexta das 8h às 18h e sábados das 8h às 12h.', nota: 0, status: 'aguardando' },
      { id: 11, autor: 'Beatriz Lima', empresa: 'LC Odontologia', pergunta: 'Consulta de urgência tem valor diferente?', resposta: 'Sim, consultas de urgência têm uma taxa adicional. Ligue para saber o valor atual.', nota: 0, status: 'aguardando' },
      { id: 12, autor: 'Diego Ramos', empresa: 'Biodents', pergunta: 'Tratamento de canal é demorado?', resposta: 'Depende da complexidade. Pode ser feito em 1 a 3 sessões. O dentista avalia no raio-X.', nota: 0, status: 'aguardando' }
    ],
    nextId: 13,
    historicoDesafios: []
  };
}

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
    if (!memoryState) memoryState = createInitialState();
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  if (!await readState()) {
    await writeState(createInitialState());
    console.log('Estado inicial da Escola de Crock criado no banco.');
  }
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
      nextId: Number(data.nextId) || 1,
      historicoDesafios: Array.isArray(data.historicoDesafios) ? data.historicoDesafios.slice(0, 80) : []
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
