// Mark the merged PR's exact Branch + repo task Done after recording its PR URL.
// No dependency installation is required in the merge workflow: Bun runs this file.
export type SyncInput = {
  token: string;
  branch: string;
  prUrl: string;
  repo: string;
};
type Request = (url: string, init: RequestInit) => Promise<Response>;
type RecordData = Record<string, unknown>;
const database = '307353d4-bca0-8045-afc1-c7e2f6ad0152';
const queryVersion = '2022-06-28';
const writeVersion = '2026-03-11';
function record(value: unknown): RecordData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected Notion object');
  }
  return value as RecordData;
}
function list(value: unknown): RecordData[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error('Expected Notion list');
  }
  return value.map(record);
}
function field(value: unknown, ...keys: string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (current === undefined) {
      return undefined;
    }
    current = record(current)[key];
  }
  return current;
}
function string(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Expected Notion string');
  }
  return value;
}
const text = (value: unknown) =>
  list(value)
    .map((part) =>
      string(part.plain_text ?? field(part, 'text', 'content') ?? ''),
    )
    .join('');
const blockText = (block: RecordData) =>
  text(field(block, string(block.type), 'rich_text'));

export async function syncTask(
  input: SyncInput,
  request: Request = fetch,
  log: (message: string) => void = console.log,
) {
  if (!input.token) {
    log('NOTION_TOKEN secret not set — skipping');
    return;
  }
  for (const field of ['branch', 'prUrl', 'repo'] as const) {
    if (!input[field]) {
      throw new Error(`Missing required input: ${field}`);
    }
  }
  async function notion(
    method: string,
    path: string,
    version: string,
    body?: RecordData,
  ): Promise<RecordData> {
    const response = await request(`https://api.notion.com/v1/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${input.token}`,
        'Notion-Version': version,
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30000),
    });
    const result = record(await response.json());
    if (!response.ok || result.object === 'error') {
      const code =
        typeof result.code === 'string' ? result.code : 'unknown_error';
      throw new Error(
        `Notion ${method} ${path} failed (${response.status}): ${code}`,
      );
    }
    return result;
  }
  function next(result: RecordData): string | undefined {
    if (!result.has_more) {
      return undefined;
    }
    if (typeof result.next_cursor !== 'string' || !result.next_cursor) {
      throw new Error('Notion pagination cursor missing');
    }
    return result.next_cursor;
  }
  const matches: RecordData[] = [];
  let cursor: string | undefined;
  do {
    const result = await notion(
      'POST',
      `databases/${database}/query`,
      queryVersion,
      {
        filter: {
          and: [
            { property: 'Branch', rich_text: { contains: input.branch } },
            { property: 'Tags', multi_select: { contains: input.repo } },
          ],
        },
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      },
    );
    for (const task of list(result.results)) {
      const branches = text(field(task, 'properties', 'Branch', 'rich_text'))
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
      if (branches.includes(input.branch)) {
        matches.push(task);
      }
    }
    cursor = next(result);
  } while (cursor);
  if (!matches.length) {
    log(`No Notion task matches Branch ${input.branch} and Tag ${input.repo}`);
    return;
  }
  if (matches.length > 1) {
    throw new Error(
      `Multiple Notion tasks match Branch ${input.branch} and Tag ${input.repo}; refusing to choose`,
    );
  }
  const task = matches[0];
  if (!task) {
    throw new Error('Expected a matching Notion task');
  }
  const taskId = string(task.id);
  const children: RecordData[] = [];
  do {
    const result = await notion(
      'GET',
      `blocks/${taskId}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ''}`,
      writeVersion,
    );
    children.push(...list(result.results));
    cursor = next(result);
  } while (cursor);
  if (!children.some((block) => blockText(block) === input.prUrl)) {
    const heading = children.findIndex(
      (block) =>
        block.type === 'heading_2' && blockText(block).trim() === 'PRs',
    );
    const headingBlock = heading >= 0 ? children[heading] : undefined;
    let after: string | undefined;
    if (headingBlock) {
      after = string(headingBlock.id);
      for (const block of children.slice(heading + 1)) {
        if (string(block.type).startsWith('heading_')) {
          break;
        }
        if (block.type === 'bulleted_list_item') {
          after = string(block.id);
        }
      }
    }
    await notion('PATCH', `blocks/${taskId}/children`, writeVersion, {
      position: after
        ? { type: 'after_block', after_block: { id: after } }
        : { type: 'end' },
      children: [
        {
          object: 'block',
          type: 'bulleted_list_item',
          bulleted_list_item: {
            rich_text: [
              {
                type: 'text',
                text: { content: input.prUrl, link: { url: input.prUrl } },
              },
            ],
          },
        },
      ],
    });
  } else {
    log('PR URL already present; skipping append');
  }
  // Preserve ordering: a failed PR append must never mark the task Done.
  const updated = await notion('PATCH', `pages/${taskId}`, writeVersion, {
    properties: { Status: { status: { name: 'Done' } } },
  });
  log(JSON.stringify({ url: updated.url }));
}

if (import.meta.main) {
  try {
    await syncTask({
      token: process.env.NOTION_TOKEN ?? '',
      branch: process.env.BRANCH ?? '',
      prUrl: process.env.PR_URL ?? '',
      repo: process.env.REPO_NAME ?? '',
    });
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : 'Notion task sync failed',
    );
    process.exitCode = 1;
  }
}
