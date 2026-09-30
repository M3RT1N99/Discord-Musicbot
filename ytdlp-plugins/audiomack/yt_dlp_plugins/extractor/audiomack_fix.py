# yt-dlp plugin: replacement Audiomack extractor.
#
# The built-in audiomack extractor has been broken since 2022 (yt-dlp#4327):
# it still queries the retired audiomack.com/api endpoint and fails with
# "Failed to parse JSON". This file is the reworked extractor from the
# (not yet merged) upstream PR yt-dlp#17258 by 0xvd, adapted to run as a
# plugin (absolute imports, test cases dropped). yt-dlp is public domain
# (Unlicense), so vendoring it here is fine.
#
# Plugin classes are registered ahead of the built-in extractors and replace
# built-ins of the same class name, so AudiomackIE/AudiomackAlbumIE below
# fully shadow the broken ones.
#
# REMOVE this plugin once a yt-dlp release contains yt-dlp#17258.

import base64
import hashlib
import hmac
import operator
import random
import time
import urllib.parse

from yt_dlp.extractor.common import InfoExtractor
from yt_dlp.utils import (
    ExtractorError,
    determine_ext,
    filter_dict,
    int_or_none,
    merge_dicts,
    remove_start,
    str_or_none,
    url_or_none,
)
from yt_dlp.utils.traversal import require, traverse_obj

# Only these are registered as extractors (not the base class)
__all__ = ['AudiomackIE', 'AudiomackAlbumIE']


class AudiomackBaseIE(InfoExtractor):
    _CONSUMER_KEY = 'bd8a07e9f23fbe9d808646b730f89b8e'

    # utils.escape_rfc3986 preserve %/;:@&=+$,!~*'()?#[]
    # Here we only preserve ~
    @staticmethod
    def rfc3986(x):
        if x is None:
            return x
        return urllib.parse.quote(str(x), safe='~')

    # Source https://audiomack.com/_next/static/chunks/9129-2b9faedd600665e1.js
    # Source https://audiomack.com/_next/static/chunks/1762-d25c1c603d5950c7.js
    def sign_params(self, params, api_url):
        CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
        params = {
            'oauth_version': '1.0',
            'oauth_signature_method': 'HMAC-SHA1',
            'oauth_consumer_key': 'audiomack-web',
            'oauth_timestamp': int(time.time()),
            'oauth_nonce': ''.join(random.choices(CHARS, k=32)),
            **params,
        }
        normalized_param_string = '&'.join(
            f'{self.rfc3986(key)}={self.rfc3986(value)}'
            for key, value in sorted(params.items())
        )

        params['oauth_signature'] = base64.b64encode(
            hmac.new(
                key=(self.rfc3986(self._CONSUMER_KEY) + '&').encode(),
                msg=(f'GET&{self.rfc3986(api_url)}&{self.rfc3986(normalized_param_string)}').encode(),
                digestmod=hashlib.sha1,
            ).digest(),
        ).decode()

        return params

    @staticmethod
    def is_available(*keys, obj, types=None):
        if types is None:
            return any(obj.get(key) is not None for key in keys)

        return any(
            isinstance(obj.get(key), types)
            for key in keys
        )

    def _get_next_data(self, webpage):
        return merge_dicts(
            *traverse_obj(
                self._search_nextjs_v13_data(webpage, None),
                (..., lambda _, x: self.is_available('uploader', 'artist', obj=x, types=dict), {dict}),
            ),
        )

    def _parse_metadata(self, data, display_id=None):
        return filter_dict({
            'display_id': display_id,
            **traverse_obj(data, {
                'id': (('id', 'song_id'), {str_or_none}, any),
                'title': ('title', {str}),
                'description': ('description', {str}),
                'thumbnail': ('image', {url_or_none}),
                'duration': ('duration', {int_or_none}),
                'timestamp': ('uploaded', {int_or_none}),
                'like_count': ('stats', 'favorites-raw', {int}),
                'view_count': ('stats', 'plays-raw', {int}),
                'repost_count': ('stats', 'reposts-raw', {int}),
                'comment_count': ('stats', 'comments', {int}),
                'release_timestamp': ('released', {int_or_none}),
                'genre': ('genre', {str}),
                'modified_timestamp': ('updated', {int_or_none}),
                'uploader': ('artist', {str}),
                'uploader_id': ('uploader', 'id', {str_or_none}),
            }),
        })

    def _get_audio_info(self, data, slug=None):
        song_id = traverse_obj(data, 'id', 'song_id')
        slug = slug or traverse_obj(data, ('links', 'self', {lambda x: urllib.parse.urlparse(x).path}, {str}))
        if not slug:
            slug = traverse_obj(data, (
                {operator.itemgetter('uploader_url_slug', 'url_slug')},
                {lambda ss: f'/{ss[0]}/song/{ss[1]}'}, {require('Song slug')},
            ))

        api_url = f'https://api.audiomack.com/v1/music/play/{song_id}'
        audio_url = traverse_obj(
            self._download_json(
                api_url, song_id,
                note='Fetching audio url',
                query=self.sign_params({
                    'environment': 'desktop-web',
                    'hq': 'true',
                    'section': f'/{remove_start(slug, "/")}',
                }, api_url),
                errnote=False, fatal=False,
            ), ('signedUrl', {url_or_none}),
        )

        if not audio_url:
            raise ExtractorError('Unable to extract audio url')

        return {
            'url': audio_url,
            'ext': determine_ext(audio_url, default_ext='mp3'),
        }


class AudiomackIE(AudiomackBaseIE):
    _VALID_URL = r'https?://(?:www\.)?audiomack\.com/(?:song/|(?=.+/song/))(?P<id>[\w/-]+)'
    IE_NAME = 'audiomack'

    def _real_extract(self, url):
        slug = self._match_id(url)
        song_id = slug.split('/')[-1]

        data = self._get_next_data(self._download_webpage(url, song_id))

        return {
            'display_id': song_id,
            **self._parse_metadata(data, song_id),
            **self._get_audio_info(data),
        }


class AudiomackAlbumIE(AudiomackBaseIE):
    _VALID_URL = r'https?://(?:www\.)?audiomack\.com/(?!.*/?song.+)(?P<id>[\w/-]+)'
    IE_NAME = 'audiomack:album'

    def _real_extract(self, url):
        slug = self._match_id(url)
        playlist_id = slug.split('/')[-1]

        data = self._get_next_data(self._download_webpage(url, playlist_id))

        def entries(data):
            for track in traverse_obj(data, ('tracks', lambda _, x: self.is_available('song_id', 'id', obj=x))) or []:
                yield {
                    **self._parse_metadata(track),
                    **self._get_audio_info(track),
                }

        return self.playlist_result(entries(data), **self._parse_metadata(data, playlist_id))
