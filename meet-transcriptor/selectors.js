/**
 * selectors.js — TODOS los selectores del DOM de Google Meet viven aquí.
 *
 * Si Google cambia el DOM y la extensión deja de capturar, este es (casi)
 * el único archivo que deberías tocar. Mira el README ("Cómo ajustar
 * selectors.js") y activa el modo debug del side panel para ver qué nodos
 * hay en la página.
 *
 * Reglas para escribir selectores:
 *  - Prioriza atributos `role` y `aria-*`: son semánticos y cambian poco.
 *  - Evita clases (`.KcIKyf`): están ofuscadas y cambian sin aviso.
 *  - Cada lista se prueba EN ORDEN; gana el primer selector que encuentre algo.
 *    Un selector inválido simplemente se ignora (no rompe nada).
 */
globalThis.MT_SELECTORS = {
  /**
   * Contenedor de los subtítulos (la "región" donde Meet pinta el CC).
   * Se busca en todo el documento. El aria-label está localizado, por eso
   * hay variantes en varios idiomas (el `i` final = sin distinguir mayúsculas).
   */
  captionsRegion: [
    '[role="region"][aria-label*="ubtítulo" i]',   // es: "Subtítulos"
    '[role="region"][aria-label*="aption" i]',     // en: "Captions"
    '[role="region"][aria-label*="egenda" i]',     // pt: "Legendas"
    '[role="region"][aria-label*="ous-titre" i]',  // fr: "Sous-titres"
    '[role="region"][aria-label*="ntertitel" i]',  // de: "Untertitel"
    '[role="region"][aria-label*="ottotitol" i]',  // it: "Sottotitoli"
    // Último recurso (selector por atributo jsname; puede estar desactualizado):
    'div[jsname="dsyhDe"]',
  ],

  /**
   * (Opcional) Cada bloque de un hablante DENTRO de la región.
   * Se evalúa con region.querySelectorAll(...).
   * Si lo dejas vacío, content.js usa una heurística: busca el ancestro
   * mínimo con nombre y texto de cada avatar (`avatar` más abajo) y, si no hay
   * avatares, desciende por los contenedores de un solo hijo.
   * Ejemplo si algún día lo necesitas: ':scope > div > div'
   */
  block: [],

  /** Avatares (<img>) usados por la heurística para delimitar los bloques. */
  avatar: ['img'],

  /**
   * (Opcional) Nombre del hablante DENTRO de un bloque.
   * Si no matchea nada, se toma el primer fragmento de texto del bloque.
   */
  speaker: [],

  /**
   * (Opcional) Texto del subtítulo DENTRO de un bloque.
   * Si no matchea nada, se toma todo el texto del bloque menos el nombre.
   */
  text: [],

  /**
   * Elementos cuyo texto se descarta al leer un bloque
   * (botones como "Ir al final", íconos de Material, etc.).
   */
  ignore: [
    'button',
    '[role="button"]',
    '[aria-hidden="true"]',
    'i',
    '[class*="material-icons" i]',
    '[class*="material-symbols" i]',
    'svg',
    'script',
    'style',
  ],

  /** Código de reunión sacado de la URL: meet.google.com/abc-defg-hij */
  meetingCode: /^\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:$|[/?#])/i,
};
