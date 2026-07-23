-- =============================================================================
-- neuralab-agent-showcase — Esquema de referencia (genérico, sin datos reales)
-- -----------------------------------------------------------------------------
-- Postgres es la fuente de verdad del sistema. Este DDL ilustra el modelo de
-- datos multi-tenant de un agente conversacional IA con RAG. Los nombres son
-- genéricos y no representan a ningún cliente. No incluye credenciales.
--
-- Requisitos: PostgreSQL 14+ con la extensión pgvector.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS vector;      -- pgvector: tipo `vector` + índices ANN
CREATE EXTENSION IF NOT EXISTS pgcrypto;    -- gen_random_uuid()

-- -----------------------------------------------------------------------------
-- bot_config
-- -----------------------------------------------------------------------------
-- Config por tenant. UN cerebro LLM compartido atiende N bots; el ruteo se hace
-- por `bot_id`. Onboarding de un cliente nuevo = INSERT en esta tabla, NO fork
-- del workflow. Cada fila define el comportamiento e integraciones de un tenant.
-- -----------------------------------------------------------------------------
CREATE TABLE bot_config (
    bot_id           TEXT PRIMARY KEY,                    -- identificador de tenant, ej: 'tenant_a'
    display_name     TEXT NOT NULL,                       -- nombre visible del asistente
    system_prompt    TEXT NOT NULL,                       -- persona + reglas de negocio del tenant
    llm_model        TEXT NOT NULL DEFAULT 'gemini-2.5-flash', -- motor principal
    judge_model      TEXT DEFAULT 'claude',               -- validador para respuestas sensibles
    rag_enabled      BOOLEAN NOT NULL DEFAULT TRUE,       -- si el tenant usa base de conocimiento
    rag_top_k        INT NOT NULL DEFAULT 4,              -- chunks a recuperar por consulta
    business_hours   JSONB DEFAULT '{}'::jsonb,           -- horarios de atención por día
    integrations     JSONB DEFAULT '{}'::jsonb,           -- flags: crm, calendario, hand-off, canales
    handoff_target   TEXT,                                -- referencia interna al asesor humano (no PII)
    active           BOOLEAN NOT NULL DEFAULT TRUE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE  bot_config IS 'Config por tenant. Aislamiento por bot_id; un cerebro sirve N clientes.';
COMMENT ON COLUMN bot_config.integrations IS 'Toggles de integración por tenant (CRM, calendario, hand-off, canales habilitados).';

-- -----------------------------------------------------------------------------
-- leads
-- -----------------------------------------------------------------------------
-- Captura y calificación de leads. Cada lead pertenece a un tenant (bot_id).
-- `external_ref` es un identificador opaco del canal (hash/id normalizado),
-- nunca el número o handle en claro en un showcase.
-- -----------------------------------------------------------------------------
CREATE TABLE leads (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id        TEXT NOT NULL REFERENCES bot_config(bot_id),
    channel       TEXT NOT NULL,                          -- 'whatsapp' | 'web_widget' | 'messenger' | ...
    external_ref  TEXT NOT NULL,                          -- id opaco del contacto en el canal
    display_name  TEXT,                                   -- nombre declarado por el lead
    stage         TEXT NOT NULL DEFAULT 'new',            -- new | qualifying | qualified | scheduled | handed_off | closed
    score         INT DEFAULT 0,                          -- calificación 0-100
    metadata      JSONB DEFAULT '{}'::jsonb,              -- campos de calificación capturados
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (bot_id, channel, external_ref)                -- un lead por contacto por canal por tenant
);

CREATE INDEX idx_leads_bot_stage ON leads (bot_id, stage);

COMMENT ON TABLE leads IS 'Leads capturados y calificados por el agente, aislados por tenant.';

-- -----------------------------------------------------------------------------
-- conversaciones
-- -----------------------------------------------------------------------------
-- Historial turno a turno. Es la memoria conversacional que se carga para
-- construir el contexto del LLM. El gate anti-leak (ver docs/arquitectura.md)
-- evita persistir aquí respuestas marcadas como sospechosas.
-- -----------------------------------------------------------------------------
CREATE TABLE conversaciones (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    bot_id        TEXT NOT NULL REFERENCES bot_config(bot_id),
    lead_id       UUID REFERENCES leads(id),
    role          TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
    content       TEXT NOT NULL,
    channel       TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_conv_bot_lead_time ON conversaciones (bot_id, lead_id, created_at);

COMMENT ON TABLE conversaciones IS 'Memoria conversacional turno a turno; fuente para construir el contexto del LLM.';

-- -----------------------------------------------------------------------------
-- knowledge
-- -----------------------------------------------------------------------------
-- Base de conocimiento para RAG. Cada fila es un chunk de texto con su embedding.
-- El retriever recupera los top-K chunks más cercanos (coseno) para el tenant.
-- La respuesta del agente se ancla estrictamente en estos chunks (anti-alucinación).
--
-- La dimensión 1536 corresponde a text-embedding-3-small de OpenAI. Ajustar
-- al modelo de embeddings elegido.
-- -----------------------------------------------------------------------------
CREATE TABLE knowledge (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    bot_id        TEXT NOT NULL REFERENCES bot_config(bot_id),
    source        TEXT,                                   -- doc de origen (ej: 'faq.md#seccion-precios')
    chunk         TEXT NOT NULL,                          -- fragmento de texto indexado
    embedding     vector(1536) NOT NULL,                  -- embedding del chunk
    metadata      JSONB DEFAULT '{}'::jsonb,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Índice vectorial ANN (HNSW) por distancia coseno. HNSW da buen recall/latencia
-- para cargas de lectura. El filtrado por bot_id se combina con el ANN scan.
CREATE INDEX idx_knowledge_embedding
    ON knowledge
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

CREATE INDEX idx_knowledge_bot ON knowledge (bot_id);

COMMENT ON TABLE knowledge IS 'Chunks + embeddings para RAG. Respuesta anclada a estos chunks (anti-alucinación).';

-- Ejemplo de consulta del retriever (top-K por coseno, aislado por tenant):
--   SELECT chunk, source
--   FROM knowledge
--   WHERE bot_id = $1
--   ORDER BY embedding <=> $2      -- $2 = embedding de la consulta del usuario
--   LIMIT $3;                      -- $3 = rag_top_k del tenant

-- -----------------------------------------------------------------------------
-- turnos_observabilidad
-- -----------------------------------------------------------------------------
-- Observabilidad por-turno. Registra cada paso del pipeline para depurar,
-- medir costo de tokens y auditar el comportamiento del agente. No reemplaza
-- a `conversaciones`: esta tabla es telemetría, no memoria del diálogo.
-- -----------------------------------------------------------------------------
CREATE TABLE turnos_observabilidad (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    bot_id          TEXT NOT NULL REFERENCES bot_config(bot_id),
    lead_id         UUID REFERENCES leads(id),
    stage           TEXT,                                 -- etapa conversacional detectada
    channel         TEXT,
    user_input      TEXT,                                 -- entrada normalizada
    llm_model       TEXT,                                 -- modelo que respondió
    rag_used        BOOLEAN DEFAULT FALSE,                -- si se consultó RAG en este turno
    rag_chunks      INT DEFAULT 0,                        -- cantidad de chunks recuperados
    raw_output      TEXT,                                 -- salida cruda del LLM (pre-sanitización)
    final_output    TEXT,                                 -- salida enviada (post-sanitización)
    leak_flagged    BOOLEAN DEFAULT FALSE,                -- si el gate anti-leak marcó el turno
    tokens_prompt   INT,
    tokens_output   INT,
    latency_ms      INT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_obs_bot_time ON turnos_observabilidad (bot_id, created_at);

COMMENT ON TABLE turnos_observabilidad IS 'Telemetría por-turno: modelo, etapa, uso de RAG, tokens, latencia, flag de leak.';

-- =============================================================================
-- Nota de aislamiento multi-tenant
-- -----------------------------------------------------------------------------
-- Todas las tablas de datos llevan `bot_id` y toda query del agente filtra por
-- él. En un despliegue productivo se recomienda además Row-Level Security (RLS)
-- por bot_id para defensa en profundidad. Ver docs/multi-tenant.md.
-- =============================================================================
