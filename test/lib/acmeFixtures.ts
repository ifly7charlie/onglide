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
