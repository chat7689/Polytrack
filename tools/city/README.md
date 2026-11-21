# The open world's map data

`maps/eugene.js` (the city the game loads) is made from two downloads by
`osm2city.js`. The downloads themselves are not in the repo.

    node tools/city/osm2city.js <eugene_raw.json> <dem.tif>

## The two downloads

1. **OpenStreetMap**, through the Overpass API (about 3.6 MB of JSON). POST
   this query to `https://overpass-api.de/api/interpreter` as `data=`:

       [out:json][timeout:90][bbox:44.0290,-123.0980,44.0430,-123.0770];
       ( way[highway]; way[building]; way[leisure]; way[landuse]; way[natural];
         way[waterway]; way[amenity]; way[barrier]; way[man_made];
         relation[building]; relation[leisure]; relation[landuse]; relation[natural];
         node[natural=tree]; node[amenity]; node[shop]; node[leisure]; node[highway]; );
       out body; >; out skel qt;

2. **Ground heights**, from the U.S. Geological Survey's 3D Elevation Program
   (about 1 MB, a 400 x 400 picture of 32-bit floats, 4 m a pixel):

       https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage?bbox=-123.0996,44.0275,-123.0796,44.0419&bboxSR=4326&imageSR=4326&size=400,400&format=tiff&pixelType=F32&interpolation=RSP_BilinearInterpolation&f=image

   `tiff.js` reads it (`node tools/city/tiff.js dem.tif` prints its range).

## What the converter does

- Cuts everything to the box set at the top of `osm2city.js` (`BOX`; `DEM_BOX`
  must be the height picture's own bbox). To move or grow the map, change the
  box and download both again for it.
- Streets become junctions and the stretches between them, with a width from
  the kind of street; alleys, service roads and paths are kept as lanes.
- Building outlines keep their kind and storeys. A name is kept only on public
  buildings; houses and flats carry no name, number or address.
- Heights: the creek's channel is filled in and the ground smoothed (about
  14 m), then stored every 10 m. The game cuts the channel again where the
  stream runs in the open, so a street crossing it stays level.

## Credit and licence

- Map data © OpenStreetMap contributors, Open Database License
  (https://www.openstreetmap.org/copyright). The game shows this line while
  the map is open, and `maps/eugene.js` carries it.
- Heights: U.S. Geological Survey, 3D Elevation Program (public domain).
