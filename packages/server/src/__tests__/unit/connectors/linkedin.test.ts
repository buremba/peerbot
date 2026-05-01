import { describe, expect, it } from 'vitest';
import { filterPostsSinceCheckpoint } from '../../../../../connectors/src/linkedin';

describe('LinkedIn checkpoint filtering', () => {
  it('drops posts at or before the saved timestamp', () => {
    const posts = [
      {
        id: '103',
        text: 'Newest',
        author: 'OpenAI',
        likes: 3,
        comments: 1,
        shares: 0,
        publishedAt: new Date('2026-03-29T12:00:00.000Z'),
      },
      {
        id: '102',
        text: 'Seen already',
        author: 'OpenAI',
        likes: 2,
        comments: 0,
        shares: 0,
        publishedAt: new Date('2026-03-28T12:00:00.000Z'),
      },
      {
        id: '101',
        text: 'Older',
        author: 'OpenAI',
        likes: 1,
        comments: 0,
        shares: 0,
        publishedAt: new Date('2026-03-27T12:00:00.000Z'),
      },
    ];

    expect(
      filterPostsSinceCheckpoint(posts, {
        last_post_id: '102',
        last_timestamp: '2026-03-28T12:00:00.000Z',
      }).map((post) => post.id)
    ).toEqual(['103']);
  });

  it('understands legacy li_post_ checkpoint ids', () => {
    const posts = [
      {
        id: '202',
        text: 'Newer',
        author: 'OpenAI',
        likes: 3,
        comments: 1,
        shares: 0,
        publishedAt: new Date('2026-03-29T12:00:00.000Z'),
      },
      {
        id: '201',
        text: 'Checkpoint',
        author: 'OpenAI',
        likes: 2,
        comments: 0,
        shares: 0,
        publishedAt: new Date('2026-03-28T12:00:00.000Z'),
      },
      {
        id: '200',
        text: 'Too old',
        author: 'OpenAI',
        likes: 1,
        comments: 0,
        shares: 0,
        publishedAt: new Date('2026-03-27T12:00:00.000Z'),
      },
    ];

    expect(
      filterPostsSinceCheckpoint(posts, {
        last_post_id: 'li_post_201',
      }).map((post) => post.id)
    ).toEqual(['202']);
  });
});
