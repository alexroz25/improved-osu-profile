// Forwards the score JSON the profile requests over XHR (extra-pages/top_ranks
// and the "show more" scores/* pages) to star-rating.js.
//
// This runs in the page's MAIN world because only there can it see the page's
// own requests. star-rating.js runs in the isolated world so the OAuth
// credentials it uses stay out of the page's reach.

(() => {
  const SCORE_URL = /\/users\/\d+\/(extra-pages\/top_ranks|scores\/(best|firsts|pinned))/;

  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    if (SCORE_URL.test(String(url))) {
      this.addEventListener('load', () => {
        if (this.responseType !== '' && this.responseType !== 'text') return;
        // Strings cross the MAIN/isolated world boundary intact; objects don't.
        document.dispatchEvent(new CustomEvent('osu-profile-plus:scores', { detail: this.responseText }));
      });
    }
    return open.call(this, method, url, ...rest);
  };
})();
