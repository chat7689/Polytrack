# The open world's map data

`maps/eugene.js` (the city the game loads) and `maps/eugene/*.jpg` (the aerial
photo on its ground) are made from four downloads. The downloads themselves are
not in the repo.

    python tools/city/photo.py <north.jpg> <south.jpg> maps/eugene <work-dir>
    node tools/city/osm2city.js <eugene_raw.json> <dem.tif> <chm.tif> <work-dir>/photo_1m.rgb

(`photo.py` first: it writes the small copy of the photo that `osm2city.js`
reads roof and tree colours from. It needs Pillow. Without the last two
arguments `osm2city.js` still works: no real heights, colours or trees.)

## The downloads

Every box below is `west,south,east,north` in degrees.

1. **OpenStreetMap**, through the Overpass API (about 3.6 MB of JSON). POST
   this query to `https://overpass-api.de/api/interpreter` as `data=`:

       [out:json][timeout:90][bbox:44.0290,-123.0980,44.0430,-123.0770];
       ( way[highway]; way[building]; way[leisure]; way[landuse]; way[natural];
         way[waterway]; way[amenity]; way[barrier]; way[man_made];
         relation[building]; relation[leisure]; relation[landuse]; relation[natural];
         node[natural=tree]; node[amenity]; node[shop]; node[leisure]; node[highway]; );
       out body; >; out skel qt;

2. **Ground heights**, U.S. Geological Survey 3D Elevation Program (1 MB):

       https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage?bbox=-123.0996,44.0275,-123.0796,44.0419&bboxSR=4326&imageSR=4326&size=400,400&format=tiff&pixelType=F32&interpolation=RSP_BilinearInterpolation&f=image

3. **Height above the ground** (buildings and trees), the Oregon Department of
   Geology and Mineral Industries' lidar, 3 ft cells, values in feet (9.4 MB):

       https://gis.dogami.oregon.gov/arcgis/rest/services/lidar/CANOPY_HEIGHT_MODEL_MOSAIC/ImageServer/exportImage?bbox=-123.0979,44.02893,-123.0806,44.04095&bboxSR=4326&imageSR=4326&size=1514,1461&format=tiff&pixelType=F32&interpolation=RSP_BilinearInterpolation&f=image

4. **The aerial photo**, Oregon Statewide Imagery Program 2022, 1 ft pixels,
   as two halves (2.4 MB each): the same request with the box's north half
   (`-123.0979,44.03494,-123.0806,44.04095`) and its south half
   (`-123.0979,44.02893,-123.0806,44.03494`):

       https://gis.odf.oregon.gov/ags3/rest/services/Basemaps/Ortho_2022_NAIP_1ft_3857/ImageServer/exportImage?bbox=<half>&bboxSR=4326&imageSR=4326&size=4541,2192&format=jpg&compressionQuality=88&bandIds=0,1,2&interpolation=RSP_BilinearInterpolation&f=image

## The trap in those requests

These servers keep a pixel square **in degrees**. Ask for a size whose shape is
not the box's shape in degrees and the picture comes back covering MORE than
the box: widened north and south about its middle. So never place a picture by
the box that was asked for:

- `tiff.js` reads where a TIFF really lies from the file's own tags (`geo`),
  and `osm2city.js` uses that;
- a JPEG says nothing, so `photo.py` works each half's real extent out from its
  width (it assumes the two requests above: same width, the box's two halves).

The first version of the map placed the ground heights by the box asked for,
and its hills were squeezed north to south by a quarter.

## What the tools do

- `osm2city.js` cuts everything to `BOX` (to move or grow the map, change it
  and download all four again). Streets become junctions and the stretches
  between them; alleys, service roads and paths are kept as lanes. Building
  outlines keep their kind; a name is kept only on public buildings (houses
  and flats carry no name, number or address). Ground heights: the creek's
  channel is filled and the ground smoothed (about 14 m), stored every 10 m.
- From the lidar: each building's height (the lower quarter and the top tenth
  of its roof), the taller parts of big buildings as boxes, and every tree
  (a top in the canopy, its height and width).
- From the photo: each roof's colour, each tree's colour.
- `photo.py` writes the ground's textures: four 2048-pixel quarters of the
  1536 m square round the origin and one small picture of all of it, cut to
  the box, and stored as paint (the game's lighting and tone mapping undone).

## Credit and licence

- Map data © OpenStreetMap contributors, Open Database License
  (https://www.openstreetmap.org/copyright). The game shows the credit line
  while the map is open, and `maps/eugene.js` carries it.
- Aerial photo: Oregon Statewide Imagery Program, 2022 (public).
- Heights: U.S. Geological Survey 3D Elevation Program (public domain) and the
  Oregon Department of Geology and Mineral Industries' lidar.
