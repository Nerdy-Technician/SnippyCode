import { describeStatus, describeUses, enrolmentRequest } from './enrolment';

describe('enrolment helpers', () => {
  test('describes uses with and without a limit', () => {
    expect(describeUses({ uses: 3, maxUses: 10 })).toBe('3 of 10');
    expect(describeUses({ uses: 3, maxUses: null })).toBe('3 (unlimited)');
  });

  test('labels each status', () => {
    expect(describeStatus({ status: 'active' })).toBe('Active');
    expect(describeStatus({ status: 'used' })).toBe('Used up');
    expect(describeStatus({ status: 'revoked' })).toBe('Revoked');
  });

  test('builds the request: blank max uses is unlimited, expiry defaults to 7 days', () => {
    expect(enrolmentRequest(4, '', '')).toEqual({ siteId: 4, maxUses: null, expiresHours: 168, label: '', allowReenrol: false });
    expect(enrolmentRequest(4, '25', '2', ' Office ')).toEqual({ siteId: 4, maxUses: 25, expiresHours: 48, label: 'Office', allowReenrol: false });
    expect(enrolmentRequest(4, '0', '365').maxUses).toBe(1);
    expect(enrolmentRequest(4, '0', '365').expiresHours).toBe(365 * 24);
    expect(enrolmentRequest(4, '0', '1000').expiresHours).toBe(365 * 24);
    expect(enrolmentRequest(4, '', '', '', true).allowReenrol).toBe(true);
  });
});
