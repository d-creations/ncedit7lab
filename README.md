# NC-Edit7 Pro

CNC NC code editor view with plot interface.

The editor integrates the ACE text editor and enables the plotting of toolpaths with the three.js library.

Licensing note: NC-Edit7 source code is licensed under the MIT License. Some repository variants or releases may also include runtime files 
. Those  files are proprietary  software, redistributed under redistribution terms, and are not covered by the MIT License.

## Live Demo

You can find the new version of the editor here: https://ncedit7.azurewebsites.net/

![NC-Edit7 editor preview](https://raw.githubusercontent.com/d-creations/NC-Edit7/master/public/images/image.png)

Static assets used by the web app and this README are stored under `public/favicon/` and `public/images/`.



## Local Development

To run the project locally:

```bash
npm install
```

To build for production:

```bash
npm run build
```

## Testing

Run unit tests with:

```bash
npm run test
```

## Transfer Configuration

The transfer panel is configured at runtime through `public/config.json` or the VS Code host configuration.


For USB storage transfer:

```json
{
	"showTransferPanel": true,
	"transferProtocol": "usb",
	"transferDefaultIp": "E:/"
}
```

In USB mode, `transferDefaultIp` is interpreted as a filesystem path visible to the backend process. Path 1 uses the selected root folder directly. Optional `PATH2` and `PATH3` subfolders are used when present.




