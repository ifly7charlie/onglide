//
// Fixed self-signed certificate for the ACME helper tests. Generated once with:
//   openssl req -x509 -newkey rsa:2048 -keyout /dev/null -out fixture.cert.pem \
//     -days 100 -nodes -subj "/CN=acme-test.example.com"
// The tests never rely on the wall clock - they pass explicit nowMs values
// derived from FIXTURE_CERT_NOT_AFTER_MS, so the fixture never "expires".
//

// Date.parse(new X509Certificate(FIXTURE_CERT_PEM).validTo) - Nov 14 18:12:59 2026 GMT
export const FIXTURE_CERT_NOT_AFTER_MS = 1794679979000;

export const FIXTURE_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIICvDCCAaQCCQDHkT9eP9OazDANBgkqhkiG9w0BAQsFADAgMR4wHAYDVQQDDBVh
Y21lLXRlc3QuZXhhbXBsZS5jb20wHhcNMjYwODA2MTgxMjU5WhcNMjYxMTE0MTgx
MjU5WjAgMR4wHAYDVQQDDBVhY21lLXRlc3QuZXhhbXBsZS5jb20wggEiMA0GCSqG
SIb3DQEBAQUAA4IBDwAwggEKAoIBAQDLLjAHJ66elJbFJ9h6/psmSifSQ+kjyHhe
gUo9XdNOSldqu0gfZ/BgtRIMW1C/orOY0hJ0Jl/ALMtdGuNmAZpmM8pajF1IVSbW
ugGOOba5oEUeL0lDcI0Y5zruFI7h8HE8fy/OnmB1QEaInZKkB5P6sAH1DjayILF8
5sVVTVH+3+c1RTeBh2dDqiRYUxyc9/CcK+Xlt3jWYkBraExIu4Nja9tjr+wz/Id3
J5lsXL/Acu6ng/XLCnFRqWiWWDRcJ7KCEPTABtV42p//sY3Q9PLh2WrtJcLfp26V
rz8UozP+dr8zpEdifP9Ud34tJjUgIEjAcePMi1lNVGmRXaIE6ALlAgMBAAEwDQYJ
KoZIhvcNAQELBQADggEBACpHD7mBIW9X268/O2os6tT7n4dzPIizjdLJo2LabEfC
gI9oSHHanLb7+PCg9bNsbAAokRmbza/a8oaszOmt80weNbGtWrQYSgsqCHjO8YcY
DV/C/1bMCEx1MjVd5JARViTubgLOAPL9CukPLmZ4/q/uwFZaKHnyc1WqynL40ZmF
CuW7u3+U4mNQI8Y+kfMZgv/NUw0XcheZzcvPG0CerM6YbxuruQqmYYEW7YPYFJgX
nzFk6GsH4BOew6sbK/UOYTw1KP7AVGlRMuF+LPLnxyeBCaqD0g1MzwTjo4wE3zXe
nmxy3zetj/YKhS5UVFFxBl2LOQ5fE7Fp/vSpe4GwCzY=
-----END CERTIFICATE-----
`;

// Self-signed with a Let's Encrypt staging style issuer, for the "issued by the
// wrong CA" checks. Generated once with:
//   openssl req -x509 -newkey rsa:2048 -keyout /dev/null -out staging.cert.pem \
//     -days 36500 -nodes -subj "/O=(STAGING) Let's Encrypt/CN=(STAGING) Pretend Pear X1"
export const FIXTURE_STAGING_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIDCjCCAfICCQCkQO5AsPsAITANBgkqhkiG9w0BAQsFADBGMSAwHgYDVQQKDBco
U1RBR0lORykgTGV0J3MgRW5jcnlwdDEiMCAGA1UEAwwZKFNUQUdJTkcpIFByZXRl
bmQgUGVhciBYMTAgFw0yNjA4MzExNzI0MDlaGA8yMTI2MDgwNzE3MjQwOVowRjEg
MB4GA1UECgwXKFNUQUdJTkcpIExldCdzIEVuY3J5cHQxIjAgBgNVBAMMGShTVEFH
SU5HKSBQcmV0ZW5kIFBlYXIgWDEwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEK
AoIBAQCnVetejbDgFHi5F2+lAKcf4B1UOJQnDqrmElUJ8Z98KT9XPKSMfof+gK5v
dbd2hj2KgPF5wqT6GAZUhiDe4auuOdjtlIV8hWPd+2rqc2UUkVnOjFzvV1zXaCkd
kRa7BgOBEPopjg5+EP3KCV4yo0hecu3/Of2Y1PMZ/NVTiDBnipBMbBCapa0/bkAG
jQ1gQAD+FtyP71mAlDE+ulLD3Nr/O7Q2tHXDsFa+liTtlfiEnvHPdQsBo5NfUO0S
frg78moZGmIqafYHzFk15t89fXNkx3pOy24ff0vYscqkvuiSyPb1HTB8uWOPFYf/
iQXxEQckITO5qY0Jd/0BNVRApD6LAgMBAAEwDQYJKoZIhvcNAQELBQADggEBAEU5
QXWOnHyAe/Xzp37JOUqK3Xw27GwYcnDOz12XbQHXijWg5EK+lkZFGbjk5ruMwwcr
6aTbRTpHu4zDe0zlWhCQSJsT+ANrNXPg8fDkXI/0+0Nu7NbtUCmb1eT/JX7VSjqy
SexYfmGBgm0+fRC1c7pJF8WbT6F5mAeh3SEPQ6w/0NYJSrUBy4dWoLYFF4jxDM6m
Opq92qH7PbQaiUzS6GDIxMgYO8+0Y0T3njxKECqSVu/AeWR0wFcj624vJ+i+6Cjo
lwf/7uF02mskqRpCmkI7dcKaYcsD7SYqgtUnAcwueCQh62v5qph4tOldVBY32xzS
BymPQ5BM5/qSt/+X2RI=
-----END CERTIFICATE-----`;
