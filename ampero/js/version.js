// Version of the editor shown in the status bar: the git commit it was loaded from.
// The page has no build step, so the commit is looked up at load time:
//   * local working copy (served from the repository root): .git/HEAD → branch ref (loose or packed)
//     – shown as "local · <id>" (may contain uncommitted changes)
//   * GitHub Pages: .git is not served there; the latest commit of the published branch via the GitHub API
//     (Pages publishes that commit, usually within a minute after the push)

const REPO = 'dtnprt/dtnprt.github.io';
const BRANCH = 'main';
const GIT = new URL('../../.git/', import.meta.url); // js/ → ampero/ → repository root

async function text(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.text();
}

async function localCommit() {
  const head = (await text(new URL('HEAD', GIT))).trim();
  const ref = /^ref: (.+)$/.exec(head)?.[1];
  if (!ref) return { id: head, ref: 'detached' };
  try {
    return { id: (await text(new URL(ref, GIT))).trim(), ref: ref.replace(/^refs\/heads\//, '') };
  } catch {
    const line = (await text(new URL('packed-refs', GIT))).split('\n').find((l) => l.endsWith(` ${ref}`));
    if (!line) throw new Error('ref not found');
    return { id: line.split(' ')[0], ref: ref.replace(/^refs\/heads\//, '') };
  }
}

async function publishedCommit() {
  const r = await fetch(`https://api.github.com/repos/${REPO}/commits/${BRANCH}`, { headers: { Accept: 'application/vnd.github+json' } });
  if (!r.ok) throw new Error(`${r.status}`);
  const j = await r.json();
  return { id: j.sha, date: j.commit?.committer?.date?.slice(0, 10) ?? '', url: j.html_url };
}

/** → {text, title, url} for the status bar; never throws. */
export async function editorVersion() {
  if (!/\.github\.io$/i.test(location.hostname)) {
    try {
      const c = await localCommit();
      if (/^[0-9a-f]{40}$/.test(c.id)) {
        return { text: `local · ${c.id.slice(0, 7)}`, title: `local working copy, branch ${c.ref}, commit ${c.id} (uncommitted changes are not shown)` };
      }
    } catch { /* not served from a git working copy */ }
  }
  try {
    const c = await publishedCommit();
    return { text: `${c.id.slice(0, 7)}${c.date ? ` · ${c.date}` : ''}`, title: `published commit ${c.id} (${REPO}, ${BRANCH})`, url: c.url };
  } catch {
    return { text: 'version unknown', title: 'the commit could not be determined (offline or GitHub API limit)' };
  }
}
