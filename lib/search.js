// Web search via Google News RSS + article reading. No API key needed.
const cheerio = require("cheerio");

async function searchWeb(query) {
  const cleanQuery = query
    .split(/[.!?\n]/)[0]
    .replace(/^(please\s+)?(can you\s+)?(search|look up|find)\s+(the\s+)?(web\s+)?(for\s+)?/i, "")
    .replace(/^(the\s+)?(latest|recent|current|today'?s)\s+/i, "")
    .trim();

  const url = "https://news.google.com/rss/search?q=" + encodeURIComponent(cleanQuery || query) + "&hl=en-GB&gl=GB&ceid=GB:en";
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 SamAssistant/1.0" },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`Google News search is temporarily unavailable (HTTP ${response.status}).`);

  const $ = cheerio.load(await response.text(), { xmlMode: true });
  const results = [];
  $("item").each((i, el) => {
    if (i >= 5) return false;
    const title = $(el).find("title").first().text().trim();
    const link = $(el).find("link").first().text().trim();
    const date = $(el).find("pubDate").first().text().trim();
    if (title && link) results.push({ title, link, snippet: date });
  });
  return results;
}

async function readArticle(url) {
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 SamAssistant/1.0" },
      redirect: "follow",
      signal: AbortSignal.timeout(12000)
    });
    if (!response.ok) return "";
    const $ = cheerio.load(await response.text());
    $("script, style, nav, footer, header, noscript, iframe").remove();
    const text = $("article").text().trim() || $("main").text().trim() || $("body").text().trim();
    return text.replace(/\s+/g, " ").slice(0, 7000);
  } catch {
    return "";
  }
}

// Search + read all articles in parallel. Returns a context block for the model.
async function buildWebContext(message) {
  try {
    const results = await searchWeb(message);
    const articles = await Promise.all(results.map(r => readArticle(r.link)));
    results.forEach((r, i) => { r.article = articles[i]; });
    if (!results.length) return { text: "No search results were found.", results };
    return {
      results,
      text: "LIVE SEARCH RESULTS:\n\n" + results.map((r, i) =>
        `${i + 1}. ${r.title}\nPublished: ${r.snippet}\nLink: ${r.link}\nArticle text: ${r.article || "Article could not be read."}`
      ).join("\n\n")
    };
  } catch (err) {
    return { text: "Web search unavailable: " + err.message, results: [] };
  }
}

module.exports = { searchWeb, readArticle, buildWebContext };
