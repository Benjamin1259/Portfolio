#!/bin/bash
# One-time setup: creates a self-signed local code-signing certificate so
# ProblemFramer.app can be signed with a stable identity across rebuilds.
# Without this, every rebuild gets a different ad-hoc signature, and macOS
# Keychain treats each rebuild as a new/untrusted app, re-prompting for
# permission to read the stored Gemini API key every time.
set -e

CERT_NAME="ProblemFramer Local Dev"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

if security find-identity -v -p codesigning "$KEYCHAIN" | grep -q "$CERT_NAME"; then
    echo "Certificate '$CERT_NAME' already exists. Nothing to do."
    exit 0
fi

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

openssl req -x509 -newkey rsa:2048 \
    -keyout "$TMP_DIR/key.pem" \
    -out "$TMP_DIR/cert.pem" \
    -days 3650 -nodes \
    -subj "/CN=$CERT_NAME" \
    -addext "extendedKeyUsage=codeSigning" \
    -addext "basicConstraints=critical,CA:false" \
    -addext "keyUsage=critical,digitalSignature"

openssl pkcs12 -export \
    -out "$TMP_DIR/cert.p12" \
    -inkey "$TMP_DIR/key.pem" \
    -in "$TMP_DIR/cert.pem" \
    -passout pass:temporary

echo "Importing certificate into your login keychain — macOS may ask you to confirm."
security import "$TMP_DIR/cert.p12" -k "$KEYCHAIN" -P temporary -T /usr/bin/codesign -T /usr/bin/security

echo "Done. Trusting the certificate for code signing — this may prompt once more."
security add-trusted-cert -p codeSign -k "$KEYCHAIN" "$TMP_DIR/cert.pem" 2>/dev/null || \
    echo "(Skipped adding to system trust store — not required for local codesign to work.)"

echo
echo "Certificate '$CERT_NAME' is ready. run.sh will now sign ProblemFramer.app with it."
