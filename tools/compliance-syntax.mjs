/**
 * Förbjudna mönster enligt KS compliance-baseline.
 *
 * Ligger i en egen modul så eslint.config.mjs kan importera listan och
 * tools/check-metadata.mjs kan referera till samma sanning.
 *
 * OBS: grindarna är striktare än vad som är belagt mot Torns officiella
 * regeltext — de kodar KS-baselinen. Ta inte bort en grind utan att först
 * stämma av mot regeltexten.
 */

export const KS_FORBIDDEN_SYNTAX = [
  // "Inga extra fetch/XHR/WebSocket-anrop mot Torns spelsidor"
  {
    selector: "NewExpression[callee.name='WebSocket']",
    message: 'KS: WebSocket är förbjudet — all nättrafik går genom TornApi/netGuard.',
  },
  {
    selector: "NewExpression[callee.name='EventSource']",
    message: 'KS: EventSource = bakgrundsövervakning, förbjudet.',
  },
  {
    selector: "NewExpression[callee.name='XMLHttpRequest']",
    message: 'KS: rå XHR är förbjuden — använd TornApi/netGuard.',
  },
  {
    selector: "CallExpression[callee.name='fetch']",
    message: 'KS: rå fetch är förbjuden — använd TornApi/netGuard.',
  },
  {
    selector: "CallExpression[callee.name='GM_xmlhttpRequest']",
    message: 'KS: GM_xmlhttpRequest ska gå genom netGuard-wrappern.',
  },
  {
    selector: "MemberExpression[object.name='GM'][property.name='xmlHttpRequest']",
    message: 'KS: GM.xmlHttpRequest ska gå genom netGuard-wrappern.',
  },

  // "Inga automatiska klick eller navigering i Torn"
  {
    selector: "CallExpression[callee.property.name='click']",
    message: 'KS: syntetiska klick är gameplay-automation, förbjudet.',
  },
  {
    selector: "CallExpression[callee.property.name='submit']",
    message: 'KS: automatisk formulärsubmit är förbjuden.',
  },
  {
    selector: 'NewExpression[callee.name=/^(Mouse|Pointer|Keyboard)Event$/]',
    message: 'KS: syntetiska input-events är gameplay-automation, förbjudet.',
  },
  {
    selector: "CallExpression[callee.property.name='dispatchEvent']",
    message: 'KS: dispatchEvent mot Torns DOM är gameplay-automation, förbjudet.',
  },
  {
    selector: "AssignmentExpression[left.property.name='href']",
    message: 'KS: automatisk navigation är förbjuden.',
  },
  {
    selector:
      "CallExpression[callee.property.name=/^(assign|replace)$/][callee.object.name='location']",
    message: 'KS: automatisk navigation är förbjuden.',
  },
  {
    selector:
      "CallExpression[callee.name='open'], CallExpression[callee.property.name='open'][callee.object.name='window']",
    message: 'KS: window.open är automatisk navigation, förbjudet.',
  },

  // "Inga dolda/off-screen iframes"
  {
    selector: "CallExpression[callee.property.name='createElement'][arguments.0.value='iframe']",
    message: 'KS: iframe-injektion är förbjuden.',
  },
  {
    selector: 'Literal[value=/<iframe/i]',
    message: 'KS: iframe-markup i sträng är förbjuden.',
  },
  {
    selector: 'TemplateElement[value.raw=/<iframe/i]',
    message: 'KS: iframe-markup i template literal är förbjuden.',
  },

  // "Ingen bakgrundsövervakning eller alerts baserat på skrapad siddata"
  {
    selector: "CallExpression[callee.name='setInterval']",
    message:
      'KS: polling kräver explicit undantag — motivera i allowlist och dokumentera i versionsnoteringen.',
  },
  {
    selector: "MemberExpression[object.name='Notification']",
    message: 'KS: bakgrundsnotiser baserade på siddata är förbjudna.',
  },
];
