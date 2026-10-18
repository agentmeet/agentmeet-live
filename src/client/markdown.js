import { marked } from 'marked';
import DOMPurify from 'dompurify';

const policy = {
  ALLOWED_TAGS: ['p', 'br', 'strong', 'b', 'em', 'i', 'del', 's', 'ul', 'ol', 'li',
    'blockquote', 'pre', 'code', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr',
    'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a', 'img'],
  ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'start', 'colspan', 'rowspan'],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
};

window.AgentMeetMarkdown = {
  render(text) {
    const clean = DOMPurify.sanitize(marked.parse(String(text), { async: false }), { ...policy, RETURN_DOM_FRAGMENT: true });
    for (const element of clean.querySelectorAll('a, img')) {
      for (const attr of ['href', 'src']) {
        if (!element.hasAttribute(attr)) continue;
        try {
          const url = new URL(element.getAttribute(attr), location.href);
          const protocols = attr === 'src' ? ['http:', 'https:'] : ['http:', 'https:', 'mailto:'];
          if (!protocols.includes(url.protocol)) element.removeAttribute(attr);
        } catch { element.removeAttribute(attr); }
      }
      if (element.tagName === 'A') element.setAttribute('rel', 'noopener noreferrer');
      if (element.tagName === 'IMG') element.setAttribute('referrerpolicy', 'no-referrer');
    }
    return clean;
  },
};
window.dispatchEvent(new Event('agentmeet:markdown-ready'));
