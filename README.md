# Foto a 3D

Fotografía un objeto con el móvil y recíbelo como modelo GLB en Blender. La web y el servidor funcionan en tu ordenador, dentro de tu red local; Tripo CLI realiza la generación 3D en su servicio.

```text
Móvil (foto) → servidor local (guarda la imagen) → Tripo CLI (genera GLB)
                                                    ↓
                           vista 3D en la web ← output/models/ → add-on de Blender
```

## Puesta en marcha

**Necesitas:** Node.js 20 o superior, npm, Blender 4.0 o superior, una cuenta de Tripo con créditos y el móvil y ordenador en la misma WiFi. El add-on usa el Python incluido en Blender; no requiere instalar Python por separado. La generación consume créditos de Tripo. Este proyecto no pide ni guarda tu clave de API y **no tiene contraseña**: es una herramienta para tu LAN (ver Seguridad).

1. Clona el repositorio e instala las dependencias:

   ```bash
   git clone https://github.com/edunavajas/foto-a-3d.git
   cd foto-a-3d
   npm install
   ```

2. Instala y autentica Tripo CLI **en el ordenador donde ejecutarás el servidor**:

   ```bash
   npm install -g tripo-cli
   tripo login
   tripo doctor
   ```

   `tripo login` abre el flujo de autorización en el navegador. No pegues una clave en la web, el chat ni el repositorio. Si `tripo doctor` indica que falta la autenticación, completa el inicio de sesión antes de generar.

3. Arranca el servidor:

   ```bash
   npm start
   ```

   `npm start` compila la interfaz automáticamente antes de arrancar (`prestart` ejecuta `vite build`). Escucha en el puerto `3000` y muestra la ruta de `output/models`. Para cambiar el puerto: `PORT=3001 npm start` (en PowerShell: `$env:PORT=3001; npm start`). Mantén esta terminal abierta mientras lo uses.

4. En Blender, abre **Edit → Preferences → Add-ons → Install…**, selecciona `dist/foto_a_3d.zip` y activa **Foto a 3D Auto Import**. En sus preferencias, configura **Models folder** con la ruta absoluta a `foto-a-3d/output/models`. Crea esa carpeta si todavía no existe. El add-on revisa la carpeta cada dos segundos; cada GLB nuevo se importa una vez y se coloca a la derecha de los objetos existentes, con separación. El add-on no cambia: la web publica en esa misma carpeta, y si pides máxima calidad o esqueleto verás varios GLB nuevos (uno por versión).

5. Averigua la IP local del ordenador: `hostname -I` en Linux, `ipconfig` en Windows o `ipconfig getifaddr en0` en macOS. En el móvil, conectado a la **misma WiFi**, abre `http://IP_DEL_ORDENADOR:3000`. Si cambiaste `PORT`, usa ese puerto. No necesitas HTTPS, ngrok ni un túnel.

## La web

- **Calidad**: «Rápido» genera un modelo low-poly en segundos; «Máxima calidad» entrega el modelo rápido al instante y luego lo mejora con Tripo v3.1 (tarda minutos; verás el primero mientras llega el bueno).
- **Texturas**: activado por defecto (PBR con calidad estándar). Desactívalo para un modelo sin pintar: más rápido y gasta menos créditos.
- **Esqueleto**: añade huesos al modelo final para poder animarlo en Blender. Gasta créditos extra y aparece con la etiqueta «Con esqueleto».
- La barra de progreso muestra el porcentaje real que reporta Tripo por fases («Generando modelo…», «Mejorando a máxima calidad…», «Añadiendo esqueleto…»); al terminar, la tarjeta de resultado permite girar el modelo con el dedo y **Descargar GLB**.

## Pruebas sin gastar créditos

```bash
npm test
npm run test:blender
```

`npm test` compila la interfaz y usa un CLI simulado para comprobar el servidor, la subida, los parámetros de textura y rig, la publicación del GLB, el progreso real y los errores. `npm run test:blender` instala temporalmente el ZIP del add-on en Blender, crea dos GLB de ejemplo con cubos y verifica la importación, la separación, la ausencia de duplicados y el temporizador. **Ninguno de estos comandos llama a la generación real de Tripo.**

Para comprobar únicamente la planificación del CLI, sin red ni créditos, usa una imagen local:

```bash
tripo make foto.png --json --yes --no-open --out output/prueba --dry-run
```

## Créditos (precios aproximados de hoy, pueden variar)

| Paso | Coste aproximado |
|---|---|
| Modelo rápido (tripo-p1) | ~50 créditos |
| Mejora a máxima calidad (tripo-v3.1) | ~30 créditos |
| Esqueleto (rig) | ~25 créditos |

Generar con todo activado gasta los tres pasos; los modelos intermedios se publican igualmente en `output/models` y se importan en Blender, así que un fallo en un paso posterior no pierde lo ya generado.

## Problemas habituales

| Síntoma | Qué comprobar |
|---|---|
| El móvil no abre la web | Comprueba la IP y el puerto, la misma WiFi, que no sea una red de invitados con aislamiento entre dispositivos y que el firewall permita conexiones entrantes al puerto 3000. El servidor debe seguir abierto. |
| No se abre directamente la cámara | `capture="environment"` es una indicación al navegador, no una garantía; elige «Tomar foto» si aparece un menú. |
| La foto se rechaza | Se admiten JPEG, PNG, WebP y BMP de hasta 20 MB. Si el móvil produce HEIC, conviértelo a JPEG. |
| Aparece un error de autenticación o créditos | Ejecuta `tripo doctor`; para autenticar, `tripo login`. Consulta el saldo en Tripo. No introduzcas claves en este proyecto. |
| Error de red tras enviar a Tripo | Revisa `tripo history` antes de volver a enviar: una tarea podría haberse creado aunque la conexión fallara. |
| El modelo no aparece en Blender | Comprueba que el add-on esté activado, que **Models folder** apunte exactamente a `output/models` y que exista un `.glb` allí. No vigila otras carpetas. |
| Blender instalado desde apt falla al importar/exportar glTF por falta de NumPy | En Ubuntu, instala `python3-numpy`. Las distribuciones oficiales de Blender normalmente incluyen sus dependencias. |

**Seguridad:** usa el servidor solo en una red de confianza. Escucha en la LAN para que el móvil pueda acceder, por lo que otros dispositivos de esa red también podrían enviar fotos y consumir créditos. No abras el puerto a Internet. El servidor limita tamaño y formato, rechaza solicitudes web de otro origen y solo permite una generación simultánea. No registra la salida de Tripo ni pasa claves de API al proceso; usa el perfil guardado por `tripo login`. `.gitignore` excluye fotos, modelos, la build de la web (`dist/`, incluido el ZIP del add-on, que se regenera desde `blender_addon/`), archivos `.env` y credenciales.

## Alcance y límites

- El modelo se genera a partir de **una sola foto**; las zonas que no se ven son una reconstrucción estimada por Tripo, no una medición exacta del objeto.
- El servidor mantiene el estado de los trabajos en memoria. Si lo reinicias durante una generación, la página no podrá recuperar ese trabajo; revisa `tripo history` antes de repetirlo.
- No todos los objetos se pueden riggear: si el esqueleto falla, el modelo texturizado ya está entregado y el rig es un extra que se pierde sin error.
- Se usa la salida GLB estándar, sin preset `--for`: algunos presets añaden conversiones a otros formatos que no sirven para la vista previa y la importación automática previstas aquí.
- No se ha validado aquí una generación real con una cuenta autenticada; la prueba completa necesita `tripo login`, créditos y un objeto fotografiado.

Licencia: [MIT](LICENSE).
