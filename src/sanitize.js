// Retire le code actif des pages HTML produites : un document piégé ne doit pas
// donner un HTML qui exécute du JavaScript quand on l'ouvre ensuite.
import DOMPurify from "dompurify";

export function sanitizeHtml(bytes) {
  const html = new TextDecoder().decode(bytes);
  const clean = DOMPurify.sanitize(html, {
    WHOLE_DOCUMENT: true,
    ADD_TAGS: ["meta", "title", "style"],
    ADD_ATTR: ["charset", "lang"],
    FORBID_TAGS: ["script", "iframe", "object", "embed", "form", "base", "frame", "frameset", "portal"],
    FORBID_ATTR: ["http-equiv", "srcdoc", "formaction", "ping"],
  });
  return new TextEncoder().encode(`<!DOCTYPE html>\n${clean}\n`);
}
