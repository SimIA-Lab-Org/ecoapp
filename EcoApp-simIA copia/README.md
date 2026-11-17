# EcoApp SimIA · v2

Simulador de ecografía en tiempo real para SIMIAlab (ISABIAL).

## Instalación

```bash
npm install
```

## Arrancar

```bash
npm start
```

Abrir en el navegador: `http://localhost:3000`

## Uso en red local (tablet + pantalla alumno)

Encuentra la IP del ordenador servidor (en Windows: `ipconfig`, en Mac/Linux: `ifconfig`).
Accede desde cualquier dispositivo de la misma red:

```
http://192.168.x.x:3000
```

## Estructura de carpetas

```
ecoapp-simia/
├── server.js                  ← Servidor Node.js + Socket.io
├── package.json
├── data/
│   └── clips.json             ← Catálogo de vídeos
└── public/
    ├── index.html             ← Pantalla de inicio
    ├── control.html           ← Panel del instructor
    ├── control.js             ← Lógica del instructor
    ├── eco.html               ← Monitor del alumno
    ├── images/
    │   ├── silueta-anatomica.svg
    │   ├── icono-pulmon.png
    │   ├── icono-corazon.png
    │   ├── icono-riñon.png
    │   ├── icono-utero.png
    │   ├── icono-aorta.png
    │   └── icono-miembros-inferiores.png
    └── videos/
        ├── pulmonar-apical-d/
        ├── pulmonar-apical-i/
        ├── pulmonar-basal-d/
        ├── pulmonar-basal-i/
        ├── cardiaco-eje/
        ├── cardiaco-apical/
        ├── cardiaco-subcostal/
        ├── grandes-vasos/
        ├── morrison/
        ├── esplenorenal/
        ├── douglas/
        ├── venas-d/
        └── venas-i/
```

## Añadir vídeos nuevos

1. Copia el `.mp4` en la subcarpeta correspondiente de `public/videos/`
2. Añade una entrada en `data/clips.json` con la ruta correcta
3. Reinicia el servidor

## Puntos POCUS implementados

| Nº | Zona | Icono |
|----|------|-------|
| 1 | Pulmonar apical D / I | icono-pulmon |
| 2 | Pulmonar basal D / I | icono-pulmon |
| 3 | Cardíaco eje largo/corto | icono-corazon |
| 4 | Cardíaco apical | icono-corazon |
| 5 | Cardíaco subcostal | icono-corazon |
| 6 | Grandes vasos | icono-aorta |
| 7 | Morrison D / Esplenorrenal I | icono-riñon |
| 8 | Douglas | icono-utero |
| 9 | Venas MMII D / I | icono-miembros-inferiores |
