import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'crypto';
import { formatPayload, signPayload, validateWebhookUrl, Notification } from '../src/utils/notify';

const notification: Notification = {
  event: 'run.failed',
  severity: 'error',
  title: 'Disk check failed on Acme',
  text: 'exit 1',
  siteId: 3,
  path: '/snippet/7',
  fields: [{ label: 'Exit code', value: '1' }]
};
const now = new Date('2026-10-01T09:00:00Z');

describe('notification payloads', () => {
  afterEach(() => {
    delete process.env.PUBLIC_BASE_URL;
  });

  test('Slack uses blocks with a link back when the base URL is set', () => {
    process.env.PUBLIC_BASE_URL = 'https://snippy.example/';
    const payload: any = formatPayload('slack', notification, now);

    assert.match(payload.text, /Disk check failed on Acme/);
    assert.equal(payload.blocks[1].fields[0].text, '*Exit code*\n1');
    assert.match(payload.blocks[2].elements[0].text, /<https:\/\/snippy\.example\/snippet\/7\|Open in SnippyCode>/);
  });

  test('Discord uses a coloured embed', () => {
    const payload: any = formatPayload('discord', notification, now);

    assert.equal(payload.embeds[0].title, 'Disk check failed on Acme');
    assert.equal(payload.embeds[0].color, 0xe85857);
    assert.equal(payload.embeds[0].timestamp, now.toISOString());
    assert.equal(payload.embeds[0].url, undefined);
  });

  test('Teams gets an Adaptive Card message', () => {
    const payload: any = formatPayload('teams', notification, now);
    const card = payload.attachments[0];

    assert.equal(payload.type, 'message');
    assert.equal(card.contentType, 'application/vnd.microsoft.card.adaptive');
    assert.equal(card.content.body[2].facts[0].title, 'Exit code');
  });

  test('generic webhooks get the raw event', () => {
    const payload: any = formatPayload('webhook', notification, now);

    assert.equal(payload.event, 'run.failed');
    assert.equal(payload.siteId, 3);
    assert.equal(payload.timestamp, now.toISOString());
  });

  test('signatures cover the timestamp and body', () => {
    const body = JSON.stringify({ a: 1 });
    const expected = createHmac('sha256', 'shh').update(`1700000000.${body}`).digest('hex');

    assert.equal(signPayload('shh', '1700000000', body), `sha256=${expected}`);
  });

  test('only http and https URLs are allowed', () => {
    assert.ok(validateWebhookUrl('https://hooks.slack.com/services/x'));
    assert.equal(validateWebhookUrl('file:///etc/passwd'), null);
    assert.equal(validateWebhookUrl('not a url'), null);
  });
});
