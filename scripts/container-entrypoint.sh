#!/bin/sh
set -eu
# Role is never inferred from absent Telegram configuration.
if [ "${OPENBEAR_INSTANCE_ROLE:-controller}" = managed ]; then
    export OPENBEAR_WORKSPACE="${OPENBEAR_WORKSPACE:-/workspace}"
    case "$OPENBEAR_WORKSPACE" in /*) ;; *) echo 'managed workspace must be absolute' >&2; exit 1;; esac
    [ "$OPENBEAR_WORKSPACE" != / ] || exit 1
    umask 077
    mkdir -p "$OPENBEAR_WORKSPACE" "$OPENBEAR_WORKSPACE/.home" "$OPENBEAR_WORKSPACE/workspace"
    export HOME="$OPENBEAR_WORKSPACE/.home"
    export OPENBEAR_CONFIG="${OPENBEAR_CONFIG:-$OPENBEAR_WORKSPACE/openbear.json}"
    cd "$OPENBEAR_WORKSPACE"
fi
exec "$@"
