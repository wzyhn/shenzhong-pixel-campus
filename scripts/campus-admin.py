#!/usr/bin/env python3
"""Invoke the campus administration API using the operator's private credential."""

import argparse
import json
import os
from pathlib import Path
import re
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import build_opener, HTTPRedirectHandler, ProxyHandler, Request
from uuid import UUID


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_args):
        return None


class OperatorError(Exception):
    pass


def request(opener, origin, credential, method, path, headers=None, body=None):
    fields = {'Authorization': 'Bearer ' + credential, 'Accept': 'application/json', **(headers or {})}
    try:
        with opener.open(Request(origin + '/admin/v1' + path, data=body, method=method, headers=fields), timeout=15) as reply:
            data = reply.read(1024 * 1024 + 1)
        if len(data) > 1024 * 1024:
            raise OperatorError('Admin response exceeds limit')
        return json.loads(data)
    except HTTPError as error:
        with error:
            code = None
            try:
                details = json.loads(error.read(2048))
                value = details.get('error') if isinstance(details, dict) else None
                if isinstance(value, str) and re.fullmatch('[a-z0-9_]{1,80}', value):
                    code = value
            except (ValueError, OSError):
                pass
        suffix = ' ' + code if code else ''
        raise OperatorError(f'Admin API returned HTTP {error.code}{suffix}') from None
    except (URLError, TimeoutError, ValueError, OSError):
        raise OperatorError('Admin response not confirmed. For writes, keep the same key and inspect status before retrying.') from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('method', choices=('GET', 'POST', 'PUT'))
    parser.add_argument('path', help='Private route relative to /admin/v1, for example /status')
    parser.add_argument('--key', help='Record a UUIDv4 before a write and reuse it for an exact retry')
    parser.add_argument('--revision', type=int, help='If-Match revision returned by a read or preview')
    parser.add_argument('--data', type=Path, help='Local JSON request file for a write')
    args = parser.parse_args()
    route = urlsplit(args.path)
    if (not re.fullmatch(r'/[a-z0-9_-]+(?:/[a-z0-9_-]+)*', route.path) or route.fragment or route.netloc or route.scheme or
            any(ord(char) < 32 or ord(char) > 126 for char in args.path)):
        parser.error('Use an API route such as /players?q= and URL-encode query values')
    origin = os.environ.get('PAPERPLANE_CAMPUS_ADMIN_URL', 'http://127.0.0.1:8443')
    url = urlsplit(origin)
    if (url.scheme != 'https' and not (url.scheme == 'http' and url.hostname in ('127.0.0.1', '::1'))) or not url.hostname:
        parser.error('Configure the private HTTPS origin or a loopback tunnel')
    if url.username is not None or url.password is not None or url.path or url.query or url.fragment:
        parser.error('The admin origin must contain only scheme, hostname and optional port')

    environment = os.environ.get('PAPERPLANE_CAMPUS_ADMIN_ENVIRONMENT')
    if environment not in ('production', 'staging', 'local'):
        parser.error('Set PAPERPLANE_CAMPUS_ADMIN_ENVIRONMENT to the intended environment')
    token_file = os.environ.get('PAPERPLANE_CAMPUS_ADMIN_TOKEN_FILE')
    if not token_file:
        parser.error('Set PAPERPLANE_CAMPUS_ADMIN_TOKEN_FILE to your private operator credential file')
    with Path(token_file).open(encoding='ascii') as handle:
        credential = handle.read(128).strip()
    if not re.fullmatch('[A-Za-z0-9_-]{43}', credential):
        raise OperatorError('Invalid credential file')

    headers = {}
    body = None
    if args.method == 'GET':
        if args.key or args.data or args.revision is not None:
            parser.error('GET accepts only a path')
    else:
        try:
            key = UUID(args.key or '')
            if key.version != 4 or str(key) != args.key:
                raise ValueError()
        except ValueError:
            parser.error('Writes require a recorded --key with a UUIDv4')
        if args.data is None:
            parser.error('Writes require --data pointing to the JSON object to send')
        with args.data.open('rb') as handle:
            body = handle.read(384 * 1024 + 1)
        if len(body) > 384 * 1024 or not isinstance(json.loads(body), dict):
            parser.error('The request must contain a bounded JSON object')
        headers.update({'Content-Type': 'application/json', 'Idempotency-Key': args.key, 'X-Campus-Admin-Environment': environment})
        if args.revision is not None:
            if not 0 <= args.revision < 2147483647:
                parser.error('Invalid --revision')
            headers['If-Match'] = f'"{args.revision}"'

    opener = build_opener(ProxyHandler({}), NoRedirect)
    session = request(opener, origin, credential, 'GET', '/session')
    if session.get('environment') != environment:
        raise OperatorError('Private API environment does not match the intended environment')
    result = session if args.method == 'GET' and args.path == '/session' else request(
        opener, origin, credential, args.method, args.path, headers, body)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    try:
        main()
    except (OperatorError, OSError, ValueError) as error:
        sys.exit(str(error) if isinstance(error, OperatorError) else 'Unable to read the configured admin files')
