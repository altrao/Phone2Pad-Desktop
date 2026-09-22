export type GamepadData = {
    buttonEast: boolean;
    buttonWest: boolean;
    buttonNorth: boolean;
    buttonSouth: boolean;

    up: boolean;
    down: boolean;
    left: boolean;
    right: boolean;

    leftShoulder: boolean;
    rightShoulder: boolean;

    // 0..1 analog. The on-screen touch trigger still sends only 0 or 1;
    // a physical gamepad routed through the phone sends the full range.
    leftTrigger: number;
    rightTrigger: number;

    leftStickButton: boolean;
    rightStickButton: boolean;

    leftStickX: number;
    leftStickY: number;
    
    rightStickX: number;
    rightStickY: number;

    buttonStart: boolean;
    buttonSelect: boolean;
}

