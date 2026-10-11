import { parseTags, previewTargets } from './scheduleTargets';

const devices = [
  { id: 1, siteId: 10, tags: ['web'] },
  { id: 2, siteId: 10, tags: [] },
  { id: 3, siteId: 20, tags: ['web', 'db'] },
  { id: 4, siteId: 30, tags: ['db'] }
];
const ids = (list: { id: number }[]) => list.map(item => item.id).sort();

describe('previewTargets', () => {
  test('picked devices only', () => {
    expect(ids(previewTargets(devices, { siteMode: 'devices', siteIds: [], deviceIds: [2, 4], deviceTags: [] }))).toEqual([2, 4]);
  });

  test('device tag across devices, plus picked ones', () => {
    expect(ids(previewTargets(devices, { siteMode: 'devices', siteIds: [], deviceIds: [2], deviceTags: ['WEB'] }))).toEqual([1, 2, 3]);
  });

  test('several tags match devices with any of them', () => {
    expect(ids(previewTargets(devices, { siteMode: 'devices', siteIds: [], deviceIds: [], deviceTags: ['web', 'db'] }))).toEqual([1, 3, 4]);
  });

  test('sites narrowed by tag', () => {
    expect(ids(previewTargets(devices, { siteMode: 'sites', siteIds: [10, 20], deviceIds: [], deviceTags: ['db'] }))).toEqual([3]);
    expect(ids(previewTargets(devices, { siteMode: 'sites', siteIds: [10], deviceIds: [], deviceTags: [] }))).toEqual([1, 2]);
  });
});

test('parseTags cleans and de-duplicates', () => {
  expect(parseTags(' Web, db ,web,,Prod Box')).toEqual(['web', 'db', 'prod-box']);
});
