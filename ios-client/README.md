# BeakPeek iOS

Native SwiftUI client for the BeakPeek service.

## Requirements

- macOS with Xcode 15 or later
- XcodeGen

```sh
brew install xcodegen
```

## Generate and Run

From this folder:

```sh
xcodegen generate
open BeakPeek.xcodeproj
```

On first launch, enter the BeakPeek service URL, for example:

```txt
http://192.168.68.104:8787
```

The app talks to:

- `GET /api/v1/summary`
- `GET /api/v1/events`
- `GET /api/v1/species`
- `GET /api/v1/stream`
- `POST /api/v1/cameras/:cameraId/classify`
- `DELETE /api/v1/events/:id`

The Notify tab edits service-side Home Assistant notification rules. BeakPeek sends matching species alerts through Home Assistant's configured `notify.*` service, so notifications keep working even when the iOS app is closed.

Plain HTTP is allowed for LAN-hosted BeakPeek services through the app target's ATS setting.
