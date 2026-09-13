#!/usr/bin/env node
// Report upgrade candidates that pnpm's minimumReleaseAge will actually allow.
//
// Usage: node mature-versions.mjs <pkg>[@<exact-version>] [...more]
//
// For each package prints: where it is pinned in the workspace, dist-tags,
// the highest mature stable version (overall and within the current major),
// newer versions still blocked by the age gate, and the peerDependencies and
// engines of the recommended (or requested) version.
//
// Versions are ranked by semver, NOT by publish time. Maintenance lines keep
// publishing (e.g. @eslint/js 9.39.5 shipped after 10.0.1), so "most recently
// published" is often an older major.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";

function findRoot(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    if (existsSync(path.join(d, "pnpm-workspace.yaml"))) return d;
    if (path.dirname(d) === d) return null;
  }
}

const root = findRoot(process.cwd());
const workspaceYaml = root
  ? readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8")
  : "";
const ageMinutes = Number(
  /^minimumReleaseAge:\s*(\d+)/m.exec(workspaceYaml)?.[1] ?? 0,
);
const cutoff = Date.now() - ageMinutes * 60_000;
const registry = (
  process.env.npm_config_registry ?? "https://registry.npmjs.org/"
).replace(/\/?$/, "/");

const parse = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  return m ? m.slice(1).map(Number) : null;
};
const cmp = (a, b) => {
  const pa = parse(a), pb = parse(b);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
};

function workspacePins(name) {
  if (!root) return [];
  const pins = [];
  const esc = name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const cat = new RegExp(`^\\s+"?${esc}"?:\\s*(\\S+)`, "m").exec(workspaceYaml);
  if (cat) pins.push({ where: "pnpm-workspace.yaml catalog", spec: cat[1] });
  for (const group of ["apps", "packages"]) {
    const base = path.join(root, group);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base)) {
      const file = path.join(base, entry, "package.json");
      if (!existsSync(file)) continue;
      const pkg = JSON.parse(readFileSync(file, "utf8"));
      for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
        const spec = pkg[field]?.[name];
        if (spec) pins.push({ where: `${group}/${entry} ${field}`, spec });
      }
    }
  }
  return pins;
}

async function report(arg) {
  const at = arg.lastIndexOf("@");
  const name = at > 0 ? arg.slice(0, at) : arg;
  const requested = at > 0 ? arg.slice(at + 1) : null;

  const res = await fetch(registry + name.replace("/", "%2F"));
  if (!res.ok) {
    console.log(`## ${name}\n  registry error: ${res.status}\n`);
    return;
  }
  const doc = await res.json();
  const time = doc.time ?? {};
  const isMature = (v) => new Date(time[v]).getTime() < cutoff;
  const stable = Object.keys(doc.versions)
    .filter((v) => parse(v) && !doc.versions[v].deprecated)
    .sort(cmp);
  const mature = stable.filter(isMature);
  const latestTag = doc["dist-tags"]?.latest;
  const majorOf = (v) => Number(/^(\d+)/.exec(v)?.[1]);

  // Some projects only ship prereleases on their current line (e.g. nitro 3's
  // date-stamped betas) while the stable line is ancient or a placeholder.
  // When "latest" points at a prerelease on a higher major, follow that line.
  const stableBest = mature.at(-1);
  const prereleaseLine =
    latestTag && !parse(latestTag) &&
    (!stableBest || majorOf(latestTag) > majorOf(stableBest));
  const best = prereleaseLine
    ? Object.keys(doc.versions)
        .filter((v) => !parse(v) && majorOf(v) === majorOf(latestTag))
        .filter((v) => isMature(v) && !doc.versions[v].deprecated)
        .sort((a, b) => new Date(time[a]) - new Date(time[b]))
        .at(-1)
    : stableBest;

  const pins = workspacePins(name);
  const pinned = pins.map((p) => /\d+\.\d+\.\d+/.exec(p.spec)?.[0]).find(Boolean);
  const pinnedMajor = pinned ? parse(pinned)[0] : null;
  const bestInMajor = pinnedMajor === null
    ? null
    : mature.filter((v) => parse(v)[0] === pinnedMajor).at(-1);
  const blocked = prereleaseLine
    ? (isMature(latestTag) ? [] : [latestTag])
    : stable.filter((v) => (!best || cmp(v, best) > 0) && !mature.includes(v));

  const lines = [`## ${name}`];
  lines.push(
    `  pinned:          ${pins.length ? pins.map((p) => `${p.spec} (${p.where})`).join("; ") : "not in workspace"}`,
  );
  lines.push(`  dist-tags:       ${JSON.stringify(doc["dist-tags"])}`);
  lines.push(`  newest mature:   ${best ?? "none"}${best ? ` (published ${time[best]})` : ""}`);
  if (bestInMajor && bestInMajor !== best) {
    lines.push(`  mature in ${pinnedMajor}.x:  ${bestInMajor} (published ${time[bestInMajor]})`);
  }
  if (blocked.length) {
    lines.push(`  blocked (<${ageMinutes}m old): ${blocked.join(", ")}`);
  }
  if (prereleaseLine) {
    lines.push(
      `  NOTE: dist-tag "latest" is a prerelease, so "newest mature" follows that prerelease line ` +
        `(stable line tops out at ${stableBest ?? "nothing"}). Comment the catalog entry if you pin it.`,
    );
  }

  const inspect = requested ?? best;
  const meta = inspect && doc.versions[inspect];
  if (requested && !meta) {
    lines.push(`  ${requested}: no such version`);
  } else if (meta) {
    const ok = isMature(inspect);
    lines.push(`  -- ${inspect}${requested ? (ok ? " (mature)" : " (BLOCKED by age gate)") : ""}`);
    const optional = meta.peerDependenciesMeta ?? {};
    const peers = Object.entries(meta.peerDependencies ?? {}).map(
      ([p, r]) => `${p} ${r}${optional[p]?.optional ? " (optional)" : ""}`,
    );
    lines.push(`  peers:           ${peers.length ? peers.join("; ") : "none"}`);
    lines.push(`  engines.node:    ${meta.engines?.node ?? "unspecified"}`);
    if (meta.deprecated) lines.push(`  DEPRECATED:      ${meta.deprecated}`);
  }
  console.log(lines.join("\n") + "\n");
}

const args = process.argv.slice(2);
if (!args.length) {
  console.error("usage: mature-versions.mjs <pkg>[@version] [...]");
  process.exit(1);
}
console.log(`minimumReleaseAge: ${ageMinutes} minutes (cutoff ${new Date(cutoff).toISOString()})\n`);
for (const a of args) await report(a);
