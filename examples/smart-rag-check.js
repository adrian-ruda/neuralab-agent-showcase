/**
 * smart-rag-check.js
 * -----------------------------------------------------------------------------
 * Patrón "SMART RAG CHECK" (genérico, sin datos reales).
 *
 * Problema: consultar la base de conocimiento (embeddings + retrieval) en CADA
 * turno infla el prompt y el costo de tokens sin aportar. En una conversación
 * real, el conocimiento de dominio se necesita al principio (el lead pregunta
 * "qué ofrecen", "cuánto cuesta", "cómo funciona"); ya avanzada la charla
 * (agendar, confirmar datos, hand-off) el contexto ya vive en el historial y
 * el RAG solo agrega ruido y latencia.
 *
 * Solución: una función determinista decide ANTES del retrieval si vale la pena
 * consultar RAG, según (a) la etapa de la conversación, (b) señales del mensaje
 * y (c) la config del tenant. Ahorra tokens sin sacrificar precisión temprana.
 *
 * Se ejecuta como un Code node en n8n, entre "cargar estado" y el retriever.
 * Si devuelve { useRag: false }, el flujo saltea el nodo de embeddings + query
 * vectorial y va directo a construir el contexto con el historial.
 * -----------------------------------------------------------------------------
 */

'use strict';

// Etapas del funnel conversacional. En etapas tempranas el conocimiento de
// dominio es valioso; en etapas tardías el historial ya contiene lo necesario.
const KNOWLEDGE_HEAVY_STAGES = new Set(['new', 'discovery', 'qualifying']);
const KNOWLEDGE_LIGHT_STAGES = new Set(['scheduling', 'confirming', 'handoff', 'closing']);

// Señales léxicas de que el usuario pide información factual, aunque la etapa
// esté avanzada (ej: reabre una duda de precio en pleno agendamiento).
const FACTUAL_INTENT = [
  /\bcu[aá]nto\b/i,
  /\bprecio(s)?\b/i,
  /\bhorario(s)?\b/i,
  /\bofrec/i,
  /\bincluye\b/i,
  /\bcómo funciona\b/i,
  /\bqu[eé] es\b/i,
  /\bdiferencia\b/i,
];

// A partir de este nº de turnos del usuario, asumimos que el contexto de dominio
// ya fue provisto y elevamos el umbral para volver a consultar RAG.
const DEEP_CONVERSATION_TURNS = 6;

/**
 * Decide si consultar RAG en este turno.
 *
 * @param {object} params
 * @param {string} params.stage        - etapa conversacional actual (de `leads.stage`)
 * @param {string} params.userMessage  - texto del turno del usuario
 * @param {number} params.userTurns    - cantidad de turnos del usuario en la conversación
 * @param {object} params.tenant       - config del tenant (de `bot_config`)
 * @returns {{ useRag: boolean, topK: number, reason: string }}
 */
function smartRagCheck({ stage, userMessage, userTurns, tenant }) {
  const cfg = tenant || {};
  const topK = Number.isInteger(cfg.rag_top_k) ? cfg.rag_top_k : 4;

  // 1) El tenant puede tener RAG deshabilitado por completo (solo persona).
  if (cfg.rag_enabled === false) {
    return { useRag: false, topK, reason: 'rag_disabled_for_tenant' };
  }

  const msg = String(userMessage || '');
  const hasFactualIntent = FACTUAL_INTENT.some((re) => re.test(msg));

  // 2) Intención factual explícita SIEMPRE gana: consultamos, sin importar la etapa.
  if (hasFactualIntent) {
    return { useRag: true, topK, reason: 'explicit_factual_intent' };
  }

  // 3) Etapas tempranas (descubrimiento/calificación): consultar por defecto.
  if (KNOWLEDGE_HEAVY_STAGES.has(stage)) {
    return { useRag: true, topK, reason: 'early_stage_knowledge_needed' };
  }

  // 4) Etapas tardías (agendar/confirmar/hand-off): saltear RAG.
  if (KNOWLEDGE_LIGHT_STAGES.has(stage)) {
    return { useRag: false, topK, reason: 'late_stage_context_in_history' };
  }

  // 5) Conversación ya profunda sin intención factual: el historial alcanza.
  if (Number(userTurns) >= DEEP_CONVERSATION_TURNS) {
    return { useRag: false, topK, reason: 'deep_conversation_no_new_intent' };
  }

  // 6) Por defecto conservador: si hay duda y la charla es corta, consultamos.
  return { useRag: true, topK, reason: 'default_conservative' };
}

module.exports = { smartRagCheck };

// -----------------------------------------------------------------------------
// Ejemplo de uso dentro de un Code node de n8n:
//
//   const { smartRagCheck } = require('./smart-rag-check');
//   const decision = smartRagCheck({
//     stage:       $json.lead.stage,
//     userMessage: $json.message.text,
//     userTurns:   $json.state.user_turns,
//     tenant:      $json.tenant_config,
//   });
//   // decision.useRag === false -> el IF node saltea el retriever vectorial
//   // decision.topK             -> LIMIT del retriever cuando sí se consulta
//   return [{ json: { ...$json, rag_decision: decision } }];
// -----------------------------------------------------------------------------
