import React, { Component } from "react";
import PropTypes from "prop-types";
import { initialState } from "./StateReducer";
import {
  roundNumber,
  checkIsNumber,
  boundLimiter,
  relativeCoords,
  calculateBoundingArea,
  getMiddleCoords,
  getDistance,
  getRelativeZoomCoords,
  getLastPositionZoomCoords,
  handleCallback,
} from "./utils";
import makePassiveEventOption from "./makePassiveEventOption";

const Context = React.createContext({});

let reset = null;
let timer = null;
const timerTime = 100;
let throttle = false;
const throttleTime = 1;

let distance = null;
let previousDistance = null;

class StateProvider extends Component {
  state = {
    ...initialState,
    ...this.props.defaultValues,
    lastMouseEventPosition: null,
    previousScale: initialState.scale,
    eventType: false,
  };

  componentDidMount() {
    const passiveOption = makePassiveEventOption(false);

    // Panning on window to allow panning when mouse is out of wrapper
    window.addEventListener("mousedown", this.handleStartPanning, passiveOption);
    window.addEventListener("mousemove", this.handlePanning, passiveOption);
    window.addEventListener("mouseup", this.handleStopPanning, passiveOption);
    return () => {
      window.removeEventListener("mousedown", this.handleStartPanning, passiveOption);
      window.removeEventListener("mousemove", this.handlePanning, passiveOption);
      window.removeEventListener("mouseup", this.handleStopPanning, passiveOption);
    };
  }

  componentDidUpdate(oldProps, oldState) {
    const { wrapperComponent } = this.state;
    const { defaultValues } = this.props;
    if (!oldState.wrapperComponent && this.state.wrapperComponent) {
      // Zooming events on wrapper
      const passiveOption = makePassiveEventOption(false);
      wrapperComponent.addEventListener("wheel", this.handleWheel, passiveOption);
      wrapperComponent.addEventListener("dblclick", this.handleDbClick, passiveOption);
      wrapperComponent.addEventListener("touchstart", this.handlePinchStart, passiveOption);
      wrapperComponent.addEventListener("touchmove", this.handlePinch, passiveOption);
      wrapperComponent.addEventListener("touchend", this.handlePinchStop, passiveOption);
    }
    if (oldProps.defaultValues !== defaultValues) {
      // eslint-disable-next-line react/no-did-update-set-state
      this.setState({ ...defaultValues });
    }
  }

  //////////
  // Zooming
  //////////

  handleZoom = (event, customMousePosition, customDelta, customStep, customScale, coords) => {
    const {
      isDown,
      zoomingEnabled,
      disabled,
      wrapperComponent,
      contentComponent,
      positionX,
      positionY,
      scale,
      enableZoomedOutPanning,
      limitToBounds,
      enableZoomThrottling,
      transformEnabled,
    } = this.state;
    if (throttle) return;
    if (isDown || !zoomingEnabled || disabled || customScale === scale) return;
    event.preventDefault();
    event.stopPropagation();
    const { x, y, wrapperWidth, wrapperHeight } =
      coords || relativeCoords(event, wrapperComponent, contentComponent);

    // Calculate new zoom
    let newScale = this.handleCalculateZoom(customScale, customDelta, customStep);
    if (this.checkZoomBounds(newScale)) return;

    const scaleDifference = newScale - scale;

    // Mouse position
    const mouseX = checkIsNumber(customMousePosition && customMousePosition.x, x / scale);
    const mouseY = checkIsNumber(customMousePosition && customMousePosition.y, y / scale);

    if (isNaN(mouseX) || isNaN(mouseY)) return console.warn("No mouse or touch offset found");

    // Bounding area details
    const newContentWidth = wrapperWidth * newScale;
    const newContentHeight = wrapperHeight * newScale;

    const newDiffWidth = wrapperWidth - newContentWidth;
    const newDiffHeight = wrapperHeight - newContentHeight;

    // Calculate bounding area
    const { minPositionX, maxPositionX, minPositionY, maxPositionY } = calculateBoundingArea(
      wrapperWidth,
      newContentWidth,
      newDiffWidth,
      wrapperHeight,
      newContentHeight,
      newDiffHeight,
      enableZoomedOutPanning
    );

    if (!transformEnabled) return;
    // Calculate new positions
    let newPositionX = -(mouseX * scaleDifference) + positionX;
    let newPositionY = -(mouseY * scaleDifference) + positionY;

    this.setZoomTransform(
      newScale,
      boundLimiter(newPositionX, minPositionX, maxPositionX, limitToBounds),
      boundLimiter(newPositionY, minPositionY, maxPositionY, limitToBounds),
      scale,
      { x: mouseX, y: mouseY }
    );

    // throttle
    if (enableZoomThrottling) {
      throttle = true;
      setTimeout(() => {
        throttle = false;
      }, throttleTime);
    }
  };

  handleCalculateZoom = (customScale, customDelta, customStep) => {
    const { scale, sensitivity, maxScale, minScale } = this.state;
    if (typeof customScale === "number") return customScale;
    const deltaY = event ? (event.deltaY < 0 ? 1 : -1) : 0;
    const delta = checkIsNumber(customDelta, deltaY);
    const zoomSensitivity = sensitivity * 0.1;

    let newScale =
      typeof customStep !== "number"
        ? roundNumber(scale + delta * zoomSensitivity * scale, 2)
        : roundNumber(scale + (customStep * delta * scale * 0.1) / 0.5, 2);
    if (!isNaN(maxScale) && newScale >= maxScale && scale < maxScale) {
      newScale = maxScale;
    }
    if (!isNaN(minScale) && newScale <= minScale && scale > minScale) {
      newScale = minScale;
    }
    return newScale;
  };

  checkZoomBounds = scale => {
    const { maxScale, minScale } = this.state;
    return (!isNaN(maxScale) && !isNaN(minScale) && scale > maxScale) || scale < minScale;
  };

  //////////
  // Wheel
  //////////

  handleWheel = event => {
    // Wheel start event
    if (!timer) {
      this.setState({ eventType: "wheel" });
      handleCallback(this.props.onWheelStart, this.getCallbackProps());
    }

    //Wheel event
    this.handleZoom(event);
    handleCallback(this.props.onWheel, this.getCallbackProps());

    // Wheel stop event
    clearTimeout(timer);
    timer = setTimeout(() => {
      handleCallback(this.props.onWheelStop, this.getCallbackProps());
      this.setState(p => ({ eventType: p.eventType === "wheel" ? false : p.eventType }));
      timer = null;
    }, timerTime);
  };

  //////////
  // Panning
  //////////

  handleStartPanning = event => {
    const {
      isDown,
      panningEnabled,
      disabled,
      wrapperComponent,
      contentComponent,
      positionX,
      positionY,
    } = this.state;
    const { target, touches } = event;

    if (
      isDown ||
      !panningEnabled ||
      disabled ||
      !wrapperComponent.contains(target) ||
      (touches && touches.length !== 1)
    )
      return;
    if (touches && touches.length === 1) {
      distance = touches[0].clientX;
    } else {
      let points = relativeCoords(event, wrapperComponent, contentComponent, true);

      const startCoords = {
        x: points.x - positionX,
        y: points.y - positionY,
      };

      this.setPanningData(startCoords, true, "pan");
      handleCallback(this.props.onPanningStart, this.getCallbackProps());
    }
  };

  handlePanning = event => {
    const {
      isDown,
      panningEnabled,
      disabled,
      wrapperComponent,
      contentComponent,
      startPanningCoords,
      enableZoomedOutPanning,
      limitToBounds,
      positionX,
      positionY,
    } = this.state;
    if (
      event.touches &&
      event.touches.length === 1 &&
      !isDown &&
      Math.abs(distance - event.touches[0].clientX) > 1
    ) {
      // Mobile panning event because everything is based on touch navigation
      event.preventDefault();
      event.stopPropagation();
      let points = relativeCoords(event, wrapperComponent, contentComponent, true);

      const startCoords = {
        x: points.x - positionX,
        y: points.y - positionY,
      };

      this.setPanningData(startCoords, true, "pan");
      handleCallback(this.props.onPanningStart, this.getCallbackProps());
    }
    if (
      !isDown ||
      !panningEnabled ||
      disabled ||
      (event.touches && event.touches.length !== 1) ||
      !startPanningCoords
    )
      return;
    event.stopPropagation();
    event.preventDefault();

    const {
      x,
      y,
      wrapperWidth,
      wrapperHeight,
      contentWidth,
      contentHeight,
      diffWidth,
      diffHeight,
    } = relativeCoords(event, wrapperComponent, contentComponent, true);
    const newPositionX = roundNumber(x - startPanningCoords.x, 2);
    const newPositionY = roundNumber(y - startPanningCoords.y, 2);

    // Calculate bounding area
    const { minPositionX, maxPositionX, minPositionY, maxPositionY } = calculateBoundingArea(
      wrapperWidth,
      contentWidth,
      diffWidth,
      wrapperHeight,
      contentHeight,
      diffHeight,
      enableZoomedOutPanning
    );
    this.setPositionX(boundLimiter(newPositionX, minPositionX, maxPositionX, limitToBounds));
    this.setPositionY(boundLimiter(newPositionY, minPositionY, maxPositionY, limitToBounds));
    handleCallback(this.props.onPanning, this.getCallbackProps());
  };

  handleStopPanning = () => {
    const { isDown, wrapperComponent, contentComponent, scale, positionX, positionY } = this.state;
    this.setIsDown(false);
    if (isDown) {
      distance = null;
      const { x, y } = getRelativeZoomCoords({
        wrapperComponent,
        contentComponent,
        scale,
        positionX,
        positionY,
      });
      this.setState(p => ({
        lastMouseEventPosition: { x, y },
        eventType: p.eventType === "pan" ? false : p.eventType,
      }));
      handleCallback(this.props.onPanningStop, this.getCallbackProps());
    }
  };

  //////////
  // Pinching
  //////////

  handlePinchStart = event => {
    const { disabled } = this.state;
    const { touches } = event;
    if (!disabled && (touches && touches.length === 1)) this.handleStartPanning(event);
    if (disabled || (touches && touches.length !== 2)) return;
    event.preventDefault();
    event.stopPropagation();

    this.setState({
      eventType: "pinch",
    });

    handleCallback(this.props.onPinchingStart, this.getCallbackProps());
  };

  handlePinch = event => {
    const {
      pinchSensitivity,
      pinchEnabled,
      disabled,
      wrapperComponent,
      contentComponent,
      scale,
    } = this.state;
    if (event.touches.length === 1) this.handlePanning(event);
    if (event.touches.length !== 2) return;
    if (pinchEnabled && event.touches.length === 2 && !disabled) {
      const length = getDistance(event.touches[0], event.touches[1]);
      if (typeof distance === "number") {
        if (
          (distance < length && previousDistance > length) ||
          (distance > length && previousDistance < length)
        ) {
          previousDistance = distance;
        }
      } else {
        previousDistance = length;
      }

      distance = length;
      if (typeof previousDistance !== "number") return;
      const diff = previousDistance - distance;
      const delta = diff > 0 ? 1 : -1;
      const { wrapperWidth, wrapperHeight, contentWidth } = relativeCoords(
        event,
        wrapperComponent,
        contentComponent
      );
      // console.log(previousDistance, distance);
      const factor = ((contentWidth - diff) / scale / wrapperWidth) * pinchSensitivity;
      const newZoom = roundNumber(scale - factor * scale * delta * 0.025, 2);
      const middleCoords = getMiddleCoords(
        event.touches[0],
        event.touches[0],
        contentComponent,
        newZoom
      );

      if (newZoom === scale) return;
      this.handleZoom(event, middleCoords, null, null, newZoom, {
        ...middleCoords,
        wrapperWidth,
        wrapperHeight,
        contentWidth,
      });
      handleCallback(this.props.onPinching, this.getCallbackProps());
    }
  };

  handlePinchStop = () => {
    if (typeof distance === "number") {
      this.setState(p => ({ eventType: p.eventType === "pinch" ? false : p.eventType }));
      previousDistance = null;
      distance = null;
      this.setState({ middleCoords: null });

      handleCallback(this.props.onPinchingStop, this.getCallbackProps());
    }
    this.handleStopPanning();
  };

  //////////
  // Controls
  //////////

  resetLastMousePosition = () => this.setState({ lastMouseEventPosition: null });

  zoomIn = event => {
    const {
      zoomingEnabled,
      disabled,
      zoomInStep,
      scale,
      lastMouseEventPosition,
      previousScale,
      lastPositionZoomEnabled,
      wrapperComponent,
      contentComponent,
      positionX,
      positionY,
    } = this.state;
    if (!event) return console.error("Zoom in function require event prop");
    if (!zoomingEnabled || disabled) return;
    const zoomCoords = getLastPositionZoomCoords({
      resetLastMousePosition: this.resetLastMousePosition,
      lastPositionZoomEnabled,
      lastMouseEventPosition,
      previousScale,
      scale,
      wrapperComponent,
      contentComponent,
      positionX,
      positionY,
    });
    this.handleZoom(event, zoomCoords, 1, zoomInStep);
  };

  zoomOut = event => {
    const {
      zoomingEnabled,
      disabled,
      zoomOutStep,
      scale,
      lastMouseEventPosition,
      previousScale,
      lastPositionZoomEnabled,
      wrapperComponent,
      contentComponent,
      positionX,
      positionY,
    } = this.state;
    if (!event) return console.error("Zoom out function require event prop");
    if (!zoomingEnabled || disabled) return;
    const zoomCoords = getLastPositionZoomCoords({
      resetLastMousePosition: this.resetLastMousePosition,
      lastPositionZoomEnabled,
      lastMouseEventPosition,
      previousScale,
      scale,
      wrapperComponent,
      contentComponent,
      positionX,
      positionY,
    });
    this.handleZoom(event, zoomCoords, -1, zoomOutStep);
  };

  handleDbClick = event => {
    const { zoomingEnabled, disabled, dbClickStep, dbClickEnabled } = this.state;
    if (!event) return console.error("Double click function require event prop");
    if (!zoomingEnabled || disabled || !dbClickEnabled) return;
    this.handleZoom(event, false, 1, dbClickStep);
  };

  setScale = scale => {
    this.setState({ scale });
  };

  setPositionX = positionX => {
    this.setState({ positionX: roundNumber(positionX, 3) });
  };

  setPositionY = positionY => {
    this.setState({ positionY: roundNumber(positionY, 3) });
  };

  setTransform = (positionX, positionY, scale) => {
    if (!this.state.transformEnabled) return;
    !isNaN(scale) && this.setScale(scale);
    !isNaN(positionX) && this.setPositionX(positionX);
    !isNaN(positionY) && this.setPositionY(positionY);
  };

  resetTransform = animation => {
    const { defaultScale, defaultPositionX, defaultPositionY } = this.props.defaultValues;
    const { scale, positionX, positionY, disabled } = this.state;
    if (disabled) return;
    const type = isNaN(animation) ? "reset" : animation;
    this.setState({ eventType: type });
    if (scale === defaultScale && positionX === defaultPositionX && positionY === defaultPositionY)
      return;
    this.setScale(checkIsNumber(defaultScale, initialState.scale));
    this.setPositionX(checkIsNumber(defaultPositionX, initialState.positionX));
    this.setPositionY(checkIsNumber(defaultPositionY, initialState.positionY));
    clearTimeout(reset);
    reset = setTimeout(() => {
      this.setState(p => ({ eventType: p.eventType === type ? false : p.eventType }));
    }, 1);
  };

  //////////
  // Setters
  //////////

  setZoomTransform = (scale, positionX, positionY, previousScale, lastMouseEventPosition) => {
    this.setState({ scale, positionX, positionY, previousScale, lastMouseEventPosition });
  };

  setPanningData = (startPanningCoords, isDown, eventType) => {
    this.setState({ startPanningCoords, isDown, eventType });
  };

  setStartPanningCoords = startPanningCoords => {
    this.setState({ startPanningCoords });
  };

  setStartPinchDistance = startPinchDistance => {
    this.setState({ startPinchDistance });
  };

  setIsDown = isDown => {
    this.setState({ isDown });
  };

  setDistance = distance => {
    this.setState({ distance });
  };

  setPreviousDistance = previousDistance => {
    this.setState({ previousDistance });
  };

  setWrapperComponent = wrapperComponent => {
    this.setState({ wrapperComponent });
  };

  setContentComponent = contentComponent => {
    this.setState({ contentComponent });
  };

  // PROPS

  getCallbackProps = () => {
    return {
      positionX: this.state.positionX,
      positionY: this.state.positionY,
      scale: this.state.scale,
      sensitivity: this.state.sensitivity,
      maxScale: this.state.maxScale,
      minScale: this.state.minScale,
      wheelAnimationSpeed: this.state.wheelAnimationSpeed,
      zoomAnimationSpeed: this.state.zoomAnimationSpeed,
      pinchAnimationSpeed: this.state.pinchAnimationSpeed,
      panAnimationSpeed: this.state.panAnimationSpeed,
      minPositionX: this.state.minPositionX,
      minPositionY: this.state.minPositionY,
      maxPositionX: this.state.maxPositionX,
      maxPositionY: this.state.maxPositionY,
      limitToBounds: this.state.limitToBounds,
      zoomingEnabled: this.state.zoomingEnabled,
      panningEnabled: this.state.panningEnabled,
      transformEnabled: this.state.transformEnabled,
      pinchEnabled: this.state.pinchEnabled,
      enableZoomedOutPanning: this.state.enableZoomedOutPanning,
      disabled: this.state.disabled,
      zoomOutStep: this.state.zoomOutStep,
      zoomInStep: this.state.zoomInStep,
      dbClickStep: this.state.dbClickStep,
      pinchSensitivity: this.state.pinchSensitivity,
      dbClickEnabled: this.state.dbClickEnabled,
      lastPositionZoomEnabled: this.state.lastPositionZoomEnabled,
      previousScale: this.state.previousScale,
    };
  };

  render() {
    /**
     * Context provider value
     */
    const value = {
      state: this.getCallbackProps(),
      dispatch: {
        setScale: this.setScale,
        setPositionX: this.setPositionX,
        setPositionY: this.setPositionY,
        zoomIn: this.zoomIn,
        zoomOut: this.zoomOut,
        setTransform: this.setTransform,
        resetTransform: this.resetTransform,
      },
      nodes: {
        setWrapperComponent: this.setWrapperComponent,
        setContentComponent: this.setContentComponent,
      },
      internal: {
        handleZoom: this.handleZoom,
        handleStartPanning: this.handleStartPanning,
        handlePanning: this.handlePanning,
        handleStopPanning: this.handleStopPanning,
        handleDbClick: this.handleDbClick,
        handlePinchStart: this.handlePinchStart,
        handlePinch: this.handlePinch,
        handlePinchStop: this.handlePinchStop,
        eventType: this.state.eventType,
      },
    };
    const { children } = this.props;
    const content =
      typeof children === "function" ? children({ ...value.state, ...value.dispatch }) : children;

    return <Context.Provider value={value}>{content}</Context.Provider>;
  }
}

StateProvider.defaultProps = {
  defaultValues: {},
  onWheelStart: null,
  onWheel: null,
  onWheelStop: null,
  onPanningStart: null,
  onPanning: null,
  onPanningStop: null,
  onPinchingStart: null,
  onPinching: null,
  onPinchingStop: null,
};

StateProvider.propTypes = {
  children: PropTypes.any,
  defaultValues: PropTypes.object,
  onWheelStart: PropTypes.func,
  onWheel: PropTypes.func,
  onWheelStop: PropTypes.func,
  onPanningStart: PropTypes.func,
  onPanning: PropTypes.func,
  onPanningStop: PropTypes.func,
  onPinchingStart: PropTypes.func,
  onPinching: PropTypes.func,
  onPinchingStop: PropTypes.func,
};

export { Context, StateProvider };