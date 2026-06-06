const test = require('node:test');
const assert = require('node:assert/strict');
const { formatDuration, truncateMessage, shuffleArray } = require('../src/utils/formatting');

test('formatDuration formats seconds as m:ss or h:mm:ss', () => {
    assert.equal(formatDuration(0), 'unbekannt');
    assert.equal(formatDuration(65), '1:05');
    assert.equal(formatDuration(3661), '1:01:01');
});

test('truncateMessage leaves short messages unchanged and shortens long ones', () => {
    assert.equal(truncateMessage('hello', 10), 'hello');
    assert.equal(truncateMessage('abcdefghij', 8), 'abcde...');
});

test('shuffleArray preserves all entries', () => {
    const values = [1, 2, 3, 4, 5];
    const shuffled = shuffleArray([...values]);

    assert.equal(shuffled.length, values.length);
    assert.deepEqual([...shuffled].sort(), values);
});
