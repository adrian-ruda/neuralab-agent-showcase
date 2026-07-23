/**
 * sanitize-output.js
 * -----------------------------------------------------------------------------
 * Patrón de SANITIZACIÓN DETERMINISTA POST-LLM (genérico, sin datos reales).
 *
 * Principio: el LLM PROPONE, un filtro de código VALIDA y LIMPIA la salida antes
 * de enviarla al usuario. El LLM nunca habla directo al canal. Esto convierte
 * una salida probabilística en un contrato verificable y corta clases enteras
 * de fallos (leaks de prompt, JSON malformado, alucinación de estructura).
 *
 * Se ejecuta como un Code node en n8n justo después del nodo del LLM. Devuelve
 * siempre un objeto con forma estable: { text, action, leak, meta }.
 *
 * Este archivo es un ejemplo de arquitectura. No contiene lógica de negocio de
 * ningún cliente ni secretos.
 * -----------------------------------------------------------------------------
 */

'use strict';

// Marcadores que el system prompt del tenant NUNCA debería dejar salir al canal.
// Si aparecen en la salida, es señal de fuga del prompt interno o de andamiaje.
const LEAK_MARKERS = [
  /system\s*prompt/i,
  /\bBEGIN\s+INSTRUCTIONS\b/i,
  /\bassistant\s*:/i,          // el modelo "narrando" el turno en vez de responder
  /\byou are (an|a) (ai|assistant|language model)\b/i,
  /\b(api[_-]?key|bearer|authorization)\b/i,
  /\{\{\s*\$?\w+\s*\}\}/,       // plantillas sin resolver que escaparon al texto
];

// Longitud máxima razonable de un turno de chat. Salidas gigantes suelen ser
// el modelo volcando contexto o repitiéndose: se recortan.
const MAX_OUTPUT_CHARS = 1500;

/**
 * Intenta parsear la salida del LLM como JSON estructurado. Convención del
 * contrato con el modelo (definida en el system prompt):
 *   { "reply": "<texto para el usuario>", "action": "<none|handoff|schedule|capture_lead>" }
 * Si el modelo respondió texto plano, se degrada con gracia a { reply: raw }.
 */
function parseLLMOutput(raw) {
  if (typeof raw !== 'string') {
    return { reply: '', action: 'none', parseError: 'non_string_output' };
  }

  const trimmed = raw.trim();

  // El modelo a veces envuelve el JSON en fences ```json ... ```. Los quitamos.
  const unfenced = trimmed
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();

  try {
    const obj = JSON.parse(unfenced);
    return {
      reply: typeof obj.reply === 'string' ? obj.reply : '',
      action: normalizeAction(obj.action),
      parseError: null,
    };
  } catch (_) {
    // Degradación con gracia: tratamos toda la salida como el texto de respuesta.
    return { reply: trimmed, action: 'none', parseError: 'not_json' };
  }
}

/** Solo se permite un conjunto cerrado de acciones. Cualquier otra → 'none'. */
function normalizeAction(action) {
  const allowed = new Set(['none', 'handoff', 'schedule', 'capture_lead']);
  return allowed.has(action) ? action : 'none';
}

/** Detección de leak: true si algún marcador prohibido aparece en el texto. */
function detectLeak(text) {
  return LEAK_MARKERS.some((re) => re.test(text));
}

/**
 * Limpieza determinista del texto de respuesta:
 *  - colapsa espacios/blancos redundantes
 *  - elimina roles residuales al inicio ("assistant:", "bot:")
 *  - recorta a la longitud máxima en un límite de palabra
 */
function cleanText(text) {
  let out = String(text || '')
    .replace(/^\s*(assistant|bot|ai)\s*:\s*/i, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (out.length > MAX_OUTPUT_CHARS) {
    out = out.slice(0, MAX_OUTPUT_CHARS);
    const lastSpace = out.lastIndexOf(' ');
    if (lastSpace > 0) out = out.slice(0, lastSpace);
    out += '…';
  }
  return out;
}

// Respuesta segura cuando la salida es inservible o filtró algo sensible.
// Nunca reenvía la salida cruda del modelo: entrega un fallback neutro y marca
// el turno para que el gate anti-leak decida no persistirlo (ver arquitectura).
const SAFE_FALLBACK =
  'Disculpá, no pude procesar eso correctamente. ¿Podés reformularlo?';

/**
 * Punto de entrada. Toma la salida cruda del LLM y devuelve un objeto estable.
 * @param {string} rawLLMOutput
 * @returns {{ text: string, action: string, leak: boolean, meta: object }}
 */
function sanitize(rawLLMOutput) {
  const parsed = parseLLMOutput(rawLLMOutput);
  const candidate = cleanText(parsed.reply);

  // Un turno se considera sospechoso si: filtró marcadores, quedó vacío tras
  // limpiar, o el modelo devolvió una acción fuera de contrato con texto nulo.
  const leaked = detectLeak(candidate) || detectLeak(rawLLMOutput || '');
  const empty = candidate.length === 0;

  if (leaked || empty) {
    return {
      text: SAFE_FALLBACK,
      action: 'none',
      leak: leaked,            // el pipeline NO persiste turnos con leak=true
      meta: {
        reason: leaked ? 'leak_detected' : 'empty_after_clean',
        parseError: parsed.parseError,
        originalLength: (rawLLMOutput || '').length,
      },
    };
  }

  return {
    text: candidate,
    action: parsed.action,
    leak: false,
    meta: {
      parseError: parsed.parseError,   // 'not_json' es aceptable (texto plano)
      originalLength: (rawLLMOutput || '').length,
      finalLength: candidate.length,
    },
  };
}

module.exports = { sanitize, parseLLMOutput, detectLeak, cleanText };

// -----------------------------------------------------------------------------
// Ejemplo de uso dentro de un Code node de n8n:
//
//   const { sanitize } = require('./sanitize-output');
//   const raw = $json.llm_output;               // salida del nodo del LLM
//   const result = sanitize(raw);
//   // result.leak === true  -> el nodo de persistencia salta el INSERT al historial
//   // result.text           -> lo único que se envía al canal
//   return [{ json: result }];
// -----------------------------------------------------------------------------
