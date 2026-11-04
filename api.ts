/**
 * Debug journal download: GET /api/app/com.temirov.livoltek/journal?since=<epoch ms> returns the
 * entries from that time on (empty while the journal is off). See "Debug journal" in the README.
 */
module.exports = {
  async getJournal({ homey, query }: { homey: { app: { journal: { list(since: number): unknown[] } } }; query: { since?: string } }) {
    const since = Number(query.since ?? 0);
    if (!Number.isFinite(since)) throw new Error('since must be a time in epoch milliseconds');
    return homey.app.journal.list(since);
  },
};
