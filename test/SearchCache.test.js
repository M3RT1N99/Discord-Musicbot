const test = require('node:test');
const assert = require('node:assert/strict');
const SearchCache = require('../src/cache/SearchCache');

test('SearchCache returns fresh entries and expires stale ones', async () => {
    const cache = new SearchCache(20);
    cache.set('user-1', { results: [{ title: 'Song' }] });

    assert.equal(cache.has('user-1'), true);
    assert.deepEqual(cache.get('user-1').results, [{ title: 'Song' }]);

    await new Promise(resolve => setTimeout(resolve, 35));

    assert.equal(cache.get('user-1'), null);
});

test('SearchCache delete removes entries', () => {
    const cache = new SearchCache(1000);
    cache.set('user-2', { results: [{ title: 'Song' }] });
    cache.delete('user-2');

    assert.equal(cache.has('user-2'), false);
});
