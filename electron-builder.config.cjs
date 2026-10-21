// electron-builder treats an empty CSC_LINK as a certificate path, not missing credentials.
if (process.env.CSC_LINK?.trim() === '') delete process.env.CSC_LINK

const signedMac = process.platform === 'darwin' && Boolean(process.env.CSC_LINK)

if (
  signedMac &&
  ![process.env.APPLE_ID, process.env.APPLE_APP_SPECIFIC_PASSWORD, process.env.APPLE_TEAM_ID].every(Boolean)
) {
  throw new Error(
    'Signed macOS releases require APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID for notarization',
  )
}

module.exports = {
  extends: './electron-builder.yml',
  forceCodeSigning: Boolean(process.env.CSC_LINK),
  extraMetadata: { watchtowerSignedUpdates: signedMac },
  mac: {
    ...(signedMac ? {} : { identity: '-' }),
    hardenedRuntime: signedMac,
    notarize: signedMac,
  },
}
