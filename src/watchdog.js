// Watchdog: warns on Discord when the stock checks have stopped (failing runs, or GitHub no longer scheduling them).
// Runs from its own workflow, so it still works when the check itself is broken.
// Usage: node src/watchdog.js --status <status.json from the data branch> --state <watchdog.json>
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { postWebhook } from './notify/discord.js';

export const STOPPED_AFTER_MS = 2 * 3600 * 1000;

const arg = name => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : null; };
const readJson = (file, def) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return def; } };
const paris = iso => new Date(iso).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'short', timeStyle: 'short' });

/**
 * @returns {{message: object|null, state: object}} at most one message per outage, plus one when checks resume.
 */
export function watchdogDecision({ status, state, now, siteUrl, repoUrl }) {
  const last = status?.lastRunAt ?? null;
  const age = last ? now - Date.parse(last) : Infinity;
  if (age >= STOPPED_AFTER_MS) {
    if (state.alertedFor === (last ?? 'never')) return { message: null, state };
    return {
      state: { alertedFor: last ?? 'never' },
      message: { embeds: [{
        title: '⚠️ Les vérifications automatiques sont arrêtées',
        description: `${last ? `Dernière vérification réussie : ${paris(last)}.` : 'Aucune vérification réussie trouvée.'} Tant que ça dure, **aucune alerte de stock ne peut arriver**.\n\nGitHub saute parfois des passages pendant quelques heures : ça repart souvent tout seul, et vous serez prévenu quand ce sera le cas. Si ce n'est pas reparti demain, demandez à Claude de regarder.${repoUrl ? `\n\n[Historique des passages](${repoUrl}/actions/workflows/check.yml)` : ''}${siteUrl ? ` · [Tableau de bord](${siteUrl})` : ''}`,
        color: 0xe74c3c,
      }] },
    };
  }
  if (state.alertedFor) {
    return { state: {}, message: { embeds: [{ title: '✅ Les vérifications automatiques ont repris', description: `Dernière vérification : ${paris(last)}. Les alertes de stock fonctionnent à nouveau.`, color: 0x2ecc71 }] } };
  }
  return { message: null, state };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  const stateFile = arg('state');
  const { message, state } = watchdogDecision({ status: readJson(arg('status'), null), state: readJson(stateFile, {}), now: Date.now(), siteUrl: process.env.SITE_URL, repoUrl: process.env.REPO_URL });
  if (message && webhookUrl) {
    if (await postWebhook(webhookUrl, message)) fs.writeFileSync(stateFile, JSON.stringify(state) + '\n');
    console.log(message.embeds[0].title);
  } else {
    console.log(message ? 'Pas de webhook Discord configuré.' : 'Vérifications à jour.');
    if (!message) fs.writeFileSync(stateFile, JSON.stringify(state) + '\n');
  }
}
