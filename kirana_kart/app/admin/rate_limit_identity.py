"""Resolve forwarding only from explicitly configured proxy networks."""
import ipaddress
import os


def client_address(request):
    peer = request.client.host if request.client else ''
    networks = [ipaddress.ip_network(value.strip()) for value in os.environ.get('TRUSTED_PROXY_CIDRS', '').split(',') if value.strip()]
    def trusted(value):
        try:
            address = ipaddress.ip_address(value)
            return any(address in network for network in networks)
        except ValueError:
            return False
    if not trusted(peer):
        return peer
    chain = request.headers.get('x-forwarded-for', '').split(',')
    for value in reversed(chain):
        candidate = value.strip()
        try:
            ipaddress.ip_address(candidate)
        except ValueError:
            return peer
        if not trusted(candidate):
            return candidate
    return peer
