export function bearerHeaderValue(token: string): string {
  return `Bearer ${token}`
}

export function hasBearerAuthorization(header: string | undefined, token: string): boolean {
  return header === bearerHeaderValue(token)
}
