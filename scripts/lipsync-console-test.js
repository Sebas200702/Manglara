/**
 * Prueba end-to-end del lip-sync, SIN AUDIO.
 *
 * Para qué sirve: el lip-sync deriva las formas de la boca del TEXTO
 * (web/src/components/avatar/lipsync-es.ts), no del audio. Eso permite probarlo
 * sin micrófono, sin sesión de Gemini y sin gastar cuota: se le da texto y se
 * mira la boca. Si no puedes leer los labios aquí, tampoco podrás en una
 * llamada real — y al revés, si aquí se lee bien y en llamada no, el problema
 * es de sincronía, no de las formas.
 *
 * CÓMO USARLO
 *   1. Abre la app (basta con que Manglara esté visible; NO hace falta llamar).
 *   2. Abre DevTools (F12) → pestaña Console.
 *   3. Pega TODO este archivo y pulsa Enter.
 *   4. Ejecuta lo que quieras probar:
 *
 *        await fonemas()          // recorre los 15 visemas, uno a uno
 *        await frases()           // dice frases de prueba, mostrando el texto
 *        await ciego()            // TEST REAL: adivina la frase leyendo labios
 *        await di("buenos dias")  // una frase concreta
 *        __hold("U")              // congela un visema para inspeccionarlo
 *        __hold(null)             // lo libera
 *
 * Requiere que el avatar haya cargado. Si sale "falta __say", recarga con
 * Ctrl+Shift+R y espera a ver a Manglara antes de pegar esto.
 */

(() => {
  if (typeof window.__say !== "function") {
    console.error(
      "%c✗ falta __say: el avatar aún no ha cargado.\n" +
        "  Recarga con Ctrl+Shift+R, espera a ver a Manglara, y vuelve a pegar este script.",
      "color:#e11"
    );
    return;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const big = (msg, color = "#0a7") =>
    console.log(`%c${msg}`, `color:${color};font-size:15px;font-weight:bold`);

  /** Qué articulación representa cada visema, para saber qué deberías ver. */
  const DESCRIPCION = {
    sil: "silencio — boca cerrada, en reposo",
    PP: "p / b / m — labios SELLADOS",
    FF: "f — labio inferior bajo los DIENTES de arriba",
    TH: "(no se usa en español) lengua entre los dientes",
    DD: "t / d — punta de la lengua tras los dientes",
    nn: "n / ñ / l — lengua ARRIBA, pegada al paladar",
    kk: "k / g / j — abierta neutra (se articula atrás, no se ve)",
    CH: "ch / ll / y — algo fruncida, dientes juntos",
    SS: "s / z / c(e,i) — RENDIJA estrecha, dientes casi juntos",
    RR: "r / rr — algo abierta, lengua a media altura",
    aa: "a — MUY abierta",
    E: "e — media, ANCHA (estirada)",
    I: "i — poco abierta, LA MÁS ANCHA (sonrisa)",
    O: "o — REDONDA, adelantada",
    U: "u — REDONDA pequeña, MUY adelantada (beso)",
  };

  /** Frases de prueba: cubren todos los contrastes visuales importantes. */
  const FRASES = [
    "mama",                          // PP puro: labios sellados 3 veces
    "fue facil",                     // FF: labio bajo los dientes
    "si señor",                      // SS + nn
    "tu turno",                      // U redonda vs DD
    "poco a poco",                   // PP + O redonda alternando
    "mi nombre es Manglara",
    "el manglar protege la costa",
    "captura carbono y frena la erosion",
    "buenos dias, como estas",
  ];

  /** Recorre los 15 visemas, congelando cada uno para que lo puedas juzgar. */
  window.fonemas = async (holdMs = 1600) => {
    big("▶ Recorrido de fonemas — mira la boca en cada uno");
    console.log(
      "Compara lo que ves con la descripción. Los que MÁS importan para leer\n" +
        "labios son las 5 vocales (aa E I O U) y PP / FF / SS.\n"
    );
    for (const v of window.__visemes) {
      __hold(v);
      console.log(`  %c${v.padEnd(4)}%c ${DESCRIPCION[v] ?? ""}`,
        "color:#0a7;font-weight:bold;font-size:14px", "color:inherit");
      await sleep(holdMs);
    }
    __hold(null);
    big("✓ Fin del recorrido", "#0a7");
    console.log(
      "Nota: t/d/n/l se ven CASI IGUAL entre sí — es normal y correcto,\n" +
        "ni un lector de labios humano los distingue (grupo homófeno)."
    );
  };

  /** Dice una frase sin audio, mostrando antes el texto y los visemas. */
  window.di = async (texto) => {
    console.log(`%c“${texto}”`, "color:#0a7;font-size:15px;font-weight:bold");
    console.log(`  visemas: ${__phonemes(texto)}`);
    await __say(texto);
  };

  /** Dice todas las frases de prueba, con el texto a la vista. */
  window.frases = async (lista = FRASES) => {
    big("▶ Frases de prueba (con el texto a la vista)");
    for (const f of lista) {
      await window.di(f);
      await sleep(500);
    }
    big("✓ Fin de las frases", "#0a7");
  };

  /**
   * LA PRUEBA DE VERDAD: dice la frase SIN mostrarla. Intenta leerle los labios
   * y luego compara. Mostrar el texto antes hace que tu cerebro "vea" lo que ya
   * sabe, así que este es el único modo honesto de medir legibilidad.
   */
  window.ciego = async (lista = FRASES) => {
    big("▶ TEST CIEGO — no mires la consola mientras la boca se mueve");
    const orden = [...lista].sort(() => Math.random() - 0.5);
    const aciertos = [];
    for (let i = 0; i < orden.length; i++) {
      console.log(`%c--- frase ${i + 1} de ${orden.length}: mira la boca AHORA ---`,
        "color:#a70;font-weight:bold");
      await sleep(1200);
      await __say(orden[i]);
      await sleep(300);
      console.log(`     era: %c“${orden[i]}”`, "color:#0a7;font-weight:bold");
      aciertos.push(orden[i]);
      await sleep(900);
    }
    big("✓ Fin del test ciego", "#0a7");
    console.log(
      "¿Cuántas acertaste? Si fueron pocas, dime QUÉ creíste ver en vez de la\n" +
        "frase real — ese error concreto dice mucho más que “no se entiende”."
    );
  };

  /** Compara dos frases que deberían verse claramente distintas. */
  window.contraste = async (a = "mama", b = "si si si") => {
    big("▶ Contraste: dos frases que deben verse MUY distintas");
    for (const t of [a, b, a, b]) {
      console.log(`  “${t}” → ${__phonemes(t)}`);
      await __say(t);
      await sleep(600);
    }
    big("✓ Si estas dos se ven igual, el renderizado sigue mal", "#a70");
  };

  big("✓ Script de prueba de lip-sync cargado");
  console.log(
    "%cComandos:%c\n" +
      "  await fonemas()            recorre los 15 visemas uno a uno\n" +
      "  await frases()             dice frases de prueba (texto a la vista)\n" +
      "  await ciego()              TEST REAL: adivina leyendo labios\n" +
      "  await contraste()          compara 'mama' vs 'si si si'\n" +
      "  await di('buenos dias')    una frase concreta\n" +
      "  __hold('U') / __hold(null) congela / libera un visema\n" +
      "  __phonemes('hola')         ver los visemas sin mover la boca\n" +
      "  __lipsyncLog()             logs de sincronía (para llamadas reales)",
    "font-weight:bold", "color:inherit"
  );
})();
