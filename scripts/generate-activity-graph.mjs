import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const username = process.env.GITHUB_USERNAME || "QianYan-Art";
const outputPath = process.env.ACTIVITY_GRAPH_OUTPUT || "assets/activity.svg";
const token = process.env.GITHUB_TOKEN || "";

const end = new Date();
const toDate = formatDate(end);
const start = new Date(Date.UTC(
  end.getUTCFullYear() - 1,
  end.getUTCMonth(),
  end.getUTCDate(),
));
const fromDate = formatDate(start);

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;",
  })[character]);
}

function getAttribute(tag, name) {
  return tag.match(new RegExp(`\\b${name}="([^"]+)"`))?.[1] || "";
}

async function fetchGraphqlData() {
  const query = `
    query($login: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $login) {
        contributionsCollection(from: $from, to: $to) {
          contributionCalendar {
            totalContributions
            weeks {
              contributionDays {
                contributionCount
                date
              }
            }
          }
        }
      }
    }
  `;

  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "QianYan-Art-activity-graph",
    },
    body: JSON.stringify({
      query,
      variables: {
        login: username,
        from: `${fromDate}T00:00:00Z`,
        to: `${toDate}T23:59:59Z`,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`GitHub GraphQL request failed: ${response.status}`);
  }

  const payload = await response.json();
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message).join("; "));
  }

  const calendar = payload.data?.user?.contributionsCollection?.contributionCalendar;
  if (!calendar) {
    throw new Error(`GitHub user not found: ${username}`);
  }

  return {
    days: calendar.weeks.flatMap((week) => week.contributionDays),
    total: calendar.totalContributions,
  };
}

async function fetchHtmlData() {
  const url = `https://github.com/users/${encodeURIComponent(username)}/contributions?from=${fromDate}&to=${toDate}`;
  const response = await fetch(url, {
    headers: { "User-Agent": "QianYan-Art-activity-graph" },
  });

  if (!response.ok) {
    throw new Error(`GitHub contributions page failed: ${response.status}`);
  }

  const html = await response.text();
  const tooltips = new Map();
  for (const match of html.matchAll(/<tool-tip\b[^>]*\bfor="([^"]+)"[^>]*>([\s\S]*?)<\/tool-tip>/g)) {
    const count = match[2].match(/([\d,]+)\s+contributions?/i);
    tooltips.set(match[1], count ? Number(count[1].replaceAll(",", "")) : 0);
  }

  const days = [];
  for (const match of html.matchAll(/<td\b[^>]*class="ContributionCalendar-day"[^>]*><\/td>/g)) {
    const tag = match[0];
    const date = getAttribute(tag, "data-date");
    if (!date) {
      continue;
    }

    const id = getAttribute(tag, "id");
    const level = Number(getAttribute(tag, "data-level") || 0);
    days.push({ date, contributionCount: tooltips.get(id) ?? level });
  }

  if (!days.length) {
    throw new Error(`No contribution data found for ${username}`);
  }

  return {
    days,
    total: days.reduce((sum, day) => sum + day.contributionCount, 0),
  };
}

function monthLabel(date) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));
}

function buildSvg({ days, total }) {
  const width = 860;
  const height = 220;
  const chartLeft = 48;
  const chartRight = width - 20;
  const chartTop = 42;
  const chartBottom = 170;
  const maxCount = Math.max(...days.map((day) => day.contributionCount), 1);
  const lastIndex = Math.max(days.length - 1, 1);
  const points = days.map((day, index) => ({
    date: day.date,
    count: day.contributionCount,
    x: chartLeft + (index / lastIndex) * (chartRight - chartLeft),
    y: chartBottom - (day.contributionCount / maxCount) * (chartBottom - chartTop),
  }));
  const linePath = points
    .map((point, index) => `${index ? "L" : "M"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    .join(" ");
  const areaPath = `${linePath} L ${chartRight} ${chartBottom} L ${chartLeft} ${chartBottom} Z`;
  const grid = [0, 0.33, 0.66, 1]
    .map((ratio) => {
      const y = chartBottom - ratio * (chartBottom - chartTop);
      const value = Math.round(maxCount * ratio);
      return `<line x1="${chartLeft}" y1="${y.toFixed(2)}" x2="${chartRight}" y2="${y.toFixed(2)}" stroke="#edf0f5"/><text x="${chartLeft - 10}" y="${y.toFixed(2)}" text-anchor="end" dominant-baseline="middle" fill="#94a3b8" font-size="10">${value}</text>`;
    })
    .join("");
  const pointsMarkup = points
    .filter((point) => point.count > 0)
    .map((point) => `<circle cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="1.8" fill="#bfdfff"/>`)
    .join("");
  const monthPoints = points
    .map((point, index) => ({ ...point, index }))
    .filter((point) => point.date.endsWith("-01"));
  if (!monthPoints.length || monthPoints[0].index !== 0) {
    monthPoints.unshift({ ...points[0], index: 0 });
  }
  const monthsMarkup = monthPoints
    .map((point) => `<text x="${point.x.toFixed(2)}" y="${height - 16}" fill="#94a3b8" font-size="10">${escapeXml(monthLabel(point.date))}</text>`)
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <title>${escapeXml(username)} activity graph</title>
  <desc>${escapeXml(total)} contributions by day during the last year.</desc>
  <rect width="${width}" height="${height}" rx="6" fill="#ffffff"/>
  <text x="${chartLeft}" y="22" fill="#334155" font-size="14" font-weight="600">Activity</text>
  <text x="${chartRight}" y="22" text-anchor="end" fill="#64748b" font-size="12">${escapeXml(total.toLocaleString("en-US"))} contributions in the last year</text>
  ${grid}
  <path d="${areaPath}" fill="#f6c8d8" fill-opacity="0.32"/>
  <path d="${linePath}" fill="none" stroke="#8ca4ff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  ${pointsMarkup}
  ${monthsMarkup}
</svg>
`;
}

const data = token ? await fetchGraphqlData() : await fetchHtmlData();
data.days.sort((left, right) => left.date.localeCompare(right.date));
const outputFile = path.resolve(process.cwd(), outputPath);
await mkdir(path.dirname(outputFile), { recursive: true });
await writeFile(outputFile, buildSvg(data), "utf8");
console.log(`Wrote ${outputPath} for ${username}: ${data.total} contributions.`);
