import { NpcSpawn } from "../../mapviewer/data/npc/NpcSpawn";
import { CacheInfo } from "../cache/CacheInfo";
import { FloorTypeLoader, OverlayFloorTypeLoader } from "../config/floortype/FloorTypeLoader";
import { ContourGroundInfo, LocModelLoader } from "../config/loctype/LocModelLoader";
import { LocModelType } from "../config/loctype/LocModelType";
import { LocType } from "../config/loctype/LocType";
import { LocTypeLoader } from "../config/loctype/LocTypeLoader";
import { ByteBuffer } from "../io/ByteBuffer";
import { getMapSquareId } from "../map/MapFileIndex";
import { MapFileLoader } from "../map/MapFileLoader";
import { Model } from "../model/Model";
import { HSL_RGB_MAP, adjustOverlayLight, adjustUnderlayLight, packHsl } from "../util/ColorUtil";
import { generateHeight } from "../util/HeightCalc";
import { CollisionMap } from "./CollisionMap";
import { Scene } from "./Scene";
import { SceneTileModel } from "./SceneTileModel";
import { Entity } from "./entity/Entity";
import { EntityType, calculateEntityTag, getIdFromTag } from "./entity/EntityTag";
import { LocEntity } from "./entity/LocEntity";

export enum LocLoadType {
    MODELS,
    NO_MODELS,
}

function readTerrainValue(buffer: ByteBuffer, newFormat: boolean, signed: boolean = false): number {
    if (newFormat) {
        return signed ? buffer.readShort() : buffer.readUnsignedShort();
    } else {
        return signed ? buffer.readByte() : buffer.readUnsignedByte();
    }
}

export class SceneBuilder {
    static readonly BLEND_RADIUS = 5;

    private static readonly displacementX: number[] = [1, 0, -1, 0];
    private static readonly displacementY: number[] = [0, -1, 0, 1];
    private static readonly diagonalDisplacementX: number[] = [1, -1, -1, 1];
    private static readonly diagonalDisplacementY: number[] = [-1, -1, 1, 1];

    static readonly WATER_OVERLAY_ID = 5;

    newTerrainFormat: boolean;
    centerLocHeightWithSize: boolean;

    constructor(
        readonly cacheInfo: CacheInfo,
        readonly mapFileLoader: MapFileLoader,
        readonly underlayTypeLoader: FloorTypeLoader,
        readonly overlayTypeLoader: OverlayFloorTypeLoader,
        readonly locTypeLoader: LocTypeLoader,
        readonly locModelLoader: LocModelLoader,
        readonly xteasMap: Map<number, number[]>,
    ) {
        this.newTerrainFormat =
            this.cacheInfo.game === "oldschool" && this.cacheInfo.revision >= 209;
        this.centerLocHeightWithSize =
            this.cacheInfo.game === "oldschool" || this.cacheInfo.revision >= 465;
    }

    static fillEmptyTerrain(info: CacheInfo): boolean {
        return info.game === "runescape" && info.revision <= 225;
    }

    getTerrainData(mapX: number, mapY: number): Int8Array | undefined {
        return this.mapFileLoader.getTerrainData(mapX, mapY);
    }

    getLocData(mapX: number, mapY: number): Int8Array | undefined {
        return this.mapFileLoader.getLocData(mapX, mapY, this.xteasMap);
    }

    getNpcSpawnData(mapX: number, mapY: number): Int8Array | undefined {
        return this.mapFileLoader.getNpcSpawnData(mapX, mapY, this.xteasMap);
    }

    buildScene(
        baseX: number,
        baseY: number,
        sizeX: number,
        sizeY: number,
        smoothUnderlays: boolean = false,
        locLoadType: LocLoadType = LocLoadType.MODELS,
    ): Scene {
        const scene = new Scene(Scene.MAX_LEVELS, sizeX, sizeY);

        const mapStartX = Math.floor(baseX / Scene.MAP_SQUARE_SIZE);
        const mapStartY = Math.floor(baseY / Scene.MAP_SQUARE_SIZE);

        const mapEndX = Math.ceil((baseX + sizeX) / Scene.MAP_SQUARE_SIZE);
        const mapEndY = Math.ceil((baseY + sizeY) / Scene.MAP_SQUARE_SIZE);

        const emptyTerrainIds = new Set<number>();

        for (let mx = mapStartX; mx < mapEndX; mx++) {
            for (let my = mapStartY; my < mapEndY; my++) {
                const terrainData = this.getTerrainData(mx, my);
                if (terrainData) {
                    const offsetX = mx * Scene.MAP_SQUARE_SIZE - baseX;
                    const offsetY = my * Scene.MAP_SQUARE_SIZE - baseY;
                    this.decodeTerrain(scene, terrainData, offsetX, offsetY, baseX, baseY);
                } else {
                    emptyTerrainIds.add(getMapSquareId(mx, my));
                }
            }
        }

        for (let mx = mapStartX; mx < mapEndX; mx++) {
            for (let my = mapStartY; my < mapEndY; my++) {
                if (!emptyTerrainIds.has(getMapSquareId(mx, my))) {
                    continue;
                }
                const endX = (mx + 1) * Scene.MAP_SQUARE_SIZE;
                const endY = (my + 1) * Scene.MAP_SQUARE_SIZE;
                const offsetX = mx * Scene.MAP_SQUARE_SIZE - baseX;
                const offsetY = my * Scene.MAP_SQUARE_SIZE - baseY;
                const tileX = Math.max(offsetX, 0);
                const tileY = Math.max(offsetY, 0);
                const emptySizeX = endX - baseX - tileX;
                const emptySizeY = endY - baseY - tileY;
                for (let level = 0; level < scene.levels; level++) {
                    this.loadEmptyTerrain(scene, level, tileX, tileY, emptySizeX, emptySizeY);
                }
            }
        }

        this.addTileModels(scene, smoothUnderlays);
        scene.setTileMinLevels();

        if (locLoadType === LocLoadType.MODELS) {
            scene.light(this.locModelLoader.textureLoader, -50, -10, -50);
        }

        return scene;
    }

    loadEmptyTerrain(
        scene: Scene,
        level: number,
        tileX: number,
        tileY: number,
        sizeX: number,
        sizeY: number,
    ): void {
        const fillEmptyTerrain = SceneBuilder.fillEmptyTerrain(this.cacheInfo);
        for (let ty = tileY; ty < tileY + sizeY; ty++) {
            for (let tx = tileX; tx < tileX + sizeX; tx++) {
                if (tx >= 0 && tx < scene.sizeX && ty >= 0 && ty < scene.sizeY) {
                    if (level === 0) {
                        scene.tileHeights[level][tx][ty] = 0;
                        if (fillEmptyTerrain) {
                            scene.tileOverlays[level][tx][ty] = SceneBuilder.WATER_OVERLAY_ID + 1;
                        }
                    } else {
                        scene.tileHeights[level][tx][ty] =
                            scene.tileHeights[level - 1][tx][ty] - Scene.UNITS_LEVEL_HEIGHT;
                    }
                }
            }
        }
        if (tileX > 0 && scene.sizeX > tileX) {
            for (let ty = tileY + 1; ty < tileY + sizeY; ty++) {
                if (ty >= 0 && ty < scene.sizeY) {
                    scene.tileHeights[level][tileX][ty] = scene.tileHeights[level][tileX - 1][ty];
                }
            }
        }
        if (tileY > 0 && scene.sizeY > tileY) {
            for (let tx = tileX + 1; tx < tileX + sizeX; tx++) {
                if (tx >= 0 && tx < scene.sizeX) {
                    scene.tileHeights[level][tx][tileY] = scene.tileHeights[level][tx][tileY - 1];
                }
            }
        }
        if (tileX >= 0 && tileY >= 0 && tileX < scene.sizeX && tileY < scene.sizeY) {
            if (level !== 0) {
                if (
                    tileX > 0 &&
                    scene.tileHeights[level][tileX - 1][tileY] !==
                        scene.tileHeights[level - 1][tileX - 1][tileY]
                ) {
                    scene.tileHeights[level][tileX][tileY] =
                        scene.tileHeights[level][tileX - 1][tileY];
                } else if (
                    tileY <= 0 ||
                    scene.tileHeights[level][tileX][tileY - 1] ===
                        scene.tileHeights[level - 1][tileX][tileY - 1]
                ) {
                    if (
                        tileX > 0 &&
                        tileY > 0 &&
                        scene.tileHeights[level][tileX - 1][tileY - 1] !==
                            scene.tileHeights[level - 1][tileX - 1][tileY - 1]
                    ) {
                        scene.tileHeights[level][tileX][tileY] =
                            scene.tileHeights[level][tileX - 1][tileY - 1];
                    }
                } else {
                    scene.tileHeights[level][tileX][tileY] =
                        scene.tileHeights[level][tileX][tileY - 1];
                }
            } else if (tileX > 0 && scene.tileHeights[level][tileX - 1][tileY] !== 0) {
                scene.tileHeights[level][tileX][tileY] = scene.tileHeights[level][tileX - 1][tileY];
            } else if (tileY > 0 && scene.tileHeights[level][tileX][tileY - 1] !== 0) {
                scene.tileHeights[level][tileX][tileY] = scene.tileHeights[level][tileX][tileY - 1];
            } else if (
                tileX > 0 &&
                tileY > 0 &&
                scene.tileHeights[level][tileX - 1][tileY - 1] !== 0
            ) {
                scene.tileHeights[level][tileX][tileY] =
                    scene.tileHeights[level][tileX - 1][tileY - 1];
            }
        }
    }

    decodeTerrain(
        scene: Scene,
        data: Int8Array,
        offsetX: number,
        offsetY: number,
        baseX: number,
        baseY: number,
    ): void {
        const buffer = new ByteBuffer(data);

        for (let level = 0; level < Scene.MAX_LEVELS; level++) {
            for (let x = 0; x < Scene.MAP_SQUARE_SIZE; x++) {
                for (let y = 0; y < Scene.MAP_SQUARE_SIZE; y++) {
                    this.decodeTerrainTile(
                        scene,
                        buffer,
                        level,
                        x + offsetX,
                        y + offsetY,
                        baseX,
                        baseY,
                        0,
                    );
                }
            }
        }

        for (let level = 0; level < Scene.MAX_LEVELS; level++) {
            for (let x = 0; x < Scene.MAP_SQUARE_SIZE; x++) {
                for (let y = 0; y < Scene.MAP_SQUARE_SIZE; y++) {
                    const sceneX = x + offsetX;
                    const sceneY = y + offsetY;
                    if (!scene.isWithinBounds(level, sceneX, sceneY)) {
                        continue;
                    }
                    if ((scene.tileRenderFlags[level][x][y] & 0x1) === 1) {
                        let realLevel = level;
                        if ((scene.tileRenderFlags[1][x][y] & 0x2) === 2) {
                            realLevel = level - 1;
                        }

                        if (realLevel >= 0) {
                            scene.collisionMaps[realLevel].setBlockedByFloor(x, y);
                        }
                    }
                }
            }
        }
    }

    decodeTerrainTile(
        scene: Scene,
        buffer: ByteBuffer,
        level: number,
        x: number,
        y: number,
        baseX: number,
        baseY: number,
        rotOffset: number,
    ): void {
        if (scene.isWithinBounds(level, x, y)) {
            scene.tileRenderFlags[level][x][y] = 0;

            while (true) {
                const v = readTerrainValue(buffer, this.newTerrainFormat);
                if (v === 0) {
                    if (level === 0) {
                        const worldX = baseX + x + 932731;
                        const worldY = baseY + y + 556238;
                        scene.tileHeights[level][x][y] =
                            -generateHeight(worldX, worldY) * Scene.UNITS_TILE_HEIGHT_BASIS;
                    } else {
                        scene.tileHeights[level][x][y] =
                            scene.tileHeights[level - 1][x][y] - Scene.UNITS_LEVEL_HEIGHT;
                    }
                    break;
                }

                if (v === 1) {
                    let height = buffer.readUnsignedByte();
                    if (height === 1) {
                        height = 0;
                    }

                    if (level === 0) {
                        scene.tileHeights[0][x][y] = -height * Scene.UNITS_TILE_HEIGHT_BASIS;
                    } else {
                        scene.tileHeights[level][x][y] =
                            scene.tileHeights[level - 1][x][y] -
                            height * Scene.UNITS_TILE_HEIGHT_BASIS;
                    }
                    break;
                }

                if (v <= 49) {
                    scene.tileOverlays[level][x][y] = readTerrainValue(
                        buffer,
                        this.newTerrainFormat,
                    );
                    scene.tileShapes[level][x][y] = (v - 2) / 4;
                    scene.tileRotations[level][x][y] = (v - 2 + rotOffset) & 3;
                } else if (v <= 81) {
                    scene.tileRenderFlags[level][x][y] = v - 49;
                } else {
                    scene.tileUnderlays[level][x][y] = v - 81;
                }
            }
        } else {
            while (true) {
                const v = readTerrainValue(buffer, this.newTerrainFormat);
                if (v === 0) {
                    break;
                }

                if (v === 1) {
                    buffer.readUnsignedByte();
                    break;
                }

                if (v <= 49) {
                    readTerrainValue(buffer, this.newTerrainFormat);
                }
            }
        }
    }

    blendUnderlays(scene: Scene, level: number): Int32Array[] {
        const colors: Int32Array[] = new Array(scene.sizeX);
        for (let i = 0; i < scene.sizeX; i++) {
            colors[i] = new Int32Array(scene.sizeY).fill(-1);
        }

        const maxSize = Math.max(scene.sizeX, scene.sizeY);

        const hues = new Int32Array(maxSize);
        const sats = new Int32Array(hues.length);
        const light = new Int32Array(hues.length);
        const mul = new Int32Array(hues.length);
        const num = new Int32Array(hues.length);

        const blendStartX = -SceneBuilder.BLEND_RADIUS;
        const blendStartY = -SceneBuilder.BLEND_RADIUS;
        const blendEndX = scene.sizeX + SceneBuilder.BLEND_RADIUS;
        const blendEndY = scene.sizeY + SceneBuilder.BLEND_RADIUS;

        for (let xi = blendStartX; xi < blendEndX; xi++) {
            for (let yi = 0; yi < scene.sizeY; yi++) {
                const xEast = xi + SceneBuilder.BLEND_RADIUS;
                if (xEast >= 0 && xEast < scene.sizeX) {
                    const underlayId = scene.tileUnderlays[level][xEast][yi];
                    if (underlayId > 0) {
                        const underlay = this.underlayTypeLoader.load(underlayId - 1);
                        hues[yi] += underlay.getHueBlend();
                        sats[yi] += underlay.saturation;
                        light[yi] += underlay.lightness;
                        mul[yi] += underlay.getHueMultiplier();
                        num[yi]++;
                    }
                }
                const xWest = xi - SceneBuilder.BLEND_RADIUS;
                if (xWest >= 0 && xWest < scene.sizeX) {
                    const underlayId = scene.tileUnderlays[level][xWest][yi];
                    if (underlayId > 0) {
                        const underlay = this.underlayTypeLoader.load(underlayId - 1);
                        hues[yi] -= underlay.getHueBlend();
                        sats[yi] -= underlay.saturation;
                        light[yi] -= underlay.lightness;
                        mul[yi] -= underlay.getHueMultiplier();
                        num[yi]--;
                    }
                }
            }

            if (xi < 0 || xi >= scene.sizeX) {
                continue;
            }

            let runningHues = 0;
            let runningSat = 0;
            let runningLight = 0;
            let runningMultiplier = 0;
            let runningNumber = 0;

            for (let yi = blendStartY; yi < blendEndY; yi++) {
                const yNorth = yi + SceneBuilder.BLEND_RADIUS;
                if (yNorth >= 0 && yNorth < scene.sizeY) {
                    runningHues += hues[yNorth];
                    runningSat += sats[yNorth];
                    runningLight += light[yNorth];
                    runningMultiplier += mul[yNorth];
                    runningNumber += num[yNorth];
                }
                const ySouth = yi - SceneBuilder.BLEND_RADIUS;
                if (ySouth >= 0 && ySouth < scene.sizeY) {
                    runningHues -= hues[ySouth];
                    runningSat -= sats[ySouth];
                    runningLight -= light[ySouth];
                    runningMultiplier -= mul[ySouth];
                    runningNumber -= num[ySouth];
                }

                if (yi < 0 || yi >= scene.sizeX) {
                    continue;
                }

                const underlayId = scene.tileUnderlays[level][xi][yi];

                if (underlayId > 0) {
                    const avgHue = ((runningHues * 256) / runningMultiplier) | 0;
                    const avgSat = (runningSat / runningNumber) | 0;
                    const avgLight = (runningLight / runningNumber) | 0;

                    colors[xi][yi] = packHsl(avgHue, avgSat, avgLight);
                }
            }
        }

        return colors;
    }

    addTileModels(scene: Scene, smoothUnderlays: boolean): void {
        const heights = scene.tileHeights;
        const underlayIds = scene.tileUnderlays;
        const overlayIds = scene.tileOverlays;
        const tileShapes = scene.tileShapes;
        const tileRotations = scene.tileRotations;

        for (let level = 0; level < scene.levels; level++) {
            const blendedColors = this.blendUnderlays(scene, level);
            const lights = scene.calculateTileLights(level);

            for (let x = 1; x < scene.sizeX - 1; x++) {
                for (let y = 1; y < scene.sizeY - 1; y++) {
                    const underlayId = underlayIds[level][x][y] - 1;

                    const overlayId = overlayIds[level][x][y] - 1;

                    if (underlayId === -1 && overlayId === -1) {
                        continue;
                    }

                    const heightSw = heights[level][x][y];
                    const heightSe = heights[level][x + 1][y];
                    const heightNe = heights[level][x + 1][y + 1];
                    const heightNw = heights[level][x][y + 1];

                    const lightSw = lights[x][y];
                    const lightSe = lights[x + 1][y];
                    const lightNe = lights[x + 1][y + 1];
                    const lightNw = lights[x][y + 1];

                    let underlayHslSw = -1;
                    let underlayHslSe = -1;
                    let underlayHslNe = -1;
                    let underlayHslNw = -1;
                    if (underlayId !== -1) {
                        underlayHslSw = blendedColors[x][y];
                        underlayHslSe = blendedColors[x + 1][y];
                        underlayHslNe = blendedColors[x + 1][y + 1];
                        underlayHslNw = blendedColors[x][y + 1];
                        if (underlayHslSe === -1 || !smoothUnderlays) {
                            underlayHslSe = underlayHslSw;
                        }
                        if (underlayHslNe === -1 || !smoothUnderlays) {
                            underlayHslNe = underlayHslSw;
                        }
                        if (underlayHslNw === -1 || !smoothUnderlays) {
                            underlayHslNw = underlayHslSw;
                        }
                    }

                    let underlayRgb = 0;
                    if (underlayHslSw !== -1) {
                        underlayRgb = HSL_RGB_MAP[adjustUnderlayLight(underlayHslSw, 96)];
                    }

                    let tileModel: SceneTileModel;
                    if (overlayId === -1) {
                        tileModel = new SceneTileModel(
                            0,
                            0,
                            -1,
                            x,
                            y,
                            heightSw,
                            heightSe,
                            heightNe,
                            heightNw,
                            lightSw,
                            lightSe,
                            lightNe,
                            lightNw,
                            underlayHslSw,
                            underlayHslSe,
                            underlayHslNe,
                            underlayHslNw,
                            0,
                            0,
                            underlayRgb,
                            0,
                        );
                    } else {
                        const shape = tileShapes[level][x][y] + 1;
                        const rotation = tileRotations[level][x][y];

                        const overlay = this.overlayTypeLoader.load(overlayId);

                        let overlayHsl: number;
                        let overlayMinimapHsl: number;
                        if (
                            overlay.textureId !== -1 &&
                            this.locModelLoader.textureLoader.isSd(overlay.textureId)
                        ) {
                            overlayMinimapHsl = this.locModelLoader.textureLoader.getAverageHsl(
                                overlay.textureId,
                            );
                            overlayHsl = -1;
                        } else if (overlay.primaryRgb === 0xff00ff) {
                            overlayHsl = overlayMinimapHsl = -2;
                        } else {
                            overlayHsl = overlayMinimapHsl = packHsl(
                                overlay.hue,
                                overlay.saturation,
                                overlay.lightness,
                            );
                        }

                        if (overlay.secondaryRgb !== -1) {
                            overlayMinimapHsl = packHsl(
                                overlay.secondaryHue,
                                overlay.secondarySaturation,
                                overlay.secondaryLightness,
                            );
                        }

                        let overlayRgb = 0;
                        if (overlayMinimapHsl !== -2) {
                            overlayRgb = HSL_RGB_MAP[adjustOverlayLight(overlayMinimapHsl, 96)];
                        }

                        // if (overlayMinimapHsl === -2) {
                        //     overlayMinimapHsl = overlayHsl;
                        // }

                        tileModel = new SceneTileModel(
                            shape,
                            rotation,
                            overlay.textureId,
                            x,
                            y,
                            heightSw,
                            heightSe,
                            heightNe,
                            heightNw,
                            lightSw,
                            lightSe,
                            lightNe,
                            lightNw,
                            underlayHslSw,
                            underlayHslSe,
                            underlayHslNe,
                            underlayHslNw,
                            overlayHsl,
                            overlayMinimapHsl,
                            underlayRgb,
                            overlayRgb,
                        );
                    }

                    scene.newTileModel(level, x, y, tileModel);
                }
            }
        }
    }

    decodeNpcSpawns(
        scene: Scene,
        borderSize: number,
        mapX: number,
        mapY: number,
    ): NpcSpawn[] | undefined {
        const data = this.getNpcSpawnData(mapX, mapY);
        if (!data) {
            return undefined;
        }
        const spawns: NpcSpawn[] = [];

        const buffer = new ByteBuffer(data);

        const baseX = mapX * 64;
        const baseY = mapY * 64;

        while (buffer.remaining > 0) {
            const positionPacked = buffer.readUnsignedShort();
            let level = positionPacked >> 14;
            const x = (positionPacked >> 7) & 0x3f;
            const y = positionPacked & 0x3f;
            const id = buffer.readUnsignedShort();
            if (
                level > 0 &&
                (scene.tileRenderFlags[1][x + borderSize][y + borderSize] & 0x2) === 2
            ) {
                level--;
            }
            spawns.push({
                id,
                x: baseX + x,
                y: baseY + y,
                level,
            });
        }

        return spawns;
    }
}
