#!/bin/sh
set -eu
node /app/assemble-web.mjs
exec nginx -c /app/nginx-main.conf -g 'daemon off;'
