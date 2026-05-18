# NC-Edit7 Pro

CNC NC code editor view with plot interface.

The editor integrates the ACE text editor and enables the plotting of toolpaths with the three.js library.

Licensing note: NC-Edit7 source code is licensed under the MIT License. Some repository variants or releases may also include FANUC FOCAS runtime files in `backend/focas_dlls`. Those FANUC files are proprietary FANUC software, redistributed under FANUC's redistribution terms, and are not covered by the MIT License.

## Live Demo

You can find the new version of the editor here: https://ncedit7.azurewebsites.net/

![NC-Edit7 editor preview](https://raw.githubusercontent.com/d-creations/NC-Edit7/master/public/images/image.png)

Static assets used by the web app and this README are stored under `public/favicon/` and `public/images/`.



## Local Development

To run the project locally:

```bash
npm install
npm run dev
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




