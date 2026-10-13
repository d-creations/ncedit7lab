%
O0001

M20
T100
G99 G97
M3 S2000
M3 s2000
G0 X10Z0
G1X0 F0.02
G1X9.
G1 X10Z0.5
G1 Z5.0
G1 X15.0
G1 X16.0 Z5.5
G1 Z 10.0
G0 X40.0
M5
M36 S1000
M8
G0 C0
T3200
G0X20. Z7. Y0
G1X-20.0F0.02
G1 X20.0
G0 X30.
M38
M9
M3 S200
T100
G99 G97
M3 S2000
M3 s2000
G0 X10Z0
G1X0 F0.02
G1X5.
G1 X6Z0.5
G1 Z4.0
G0 X30
M5
M36 S1000
M8
G0 C0
T3300
G0X30
G0X0.Y0 Z-2.
G1Z3
G1X1.0F0.02
G1Y1.0
G0 Z-30.
M38
M9
M3 S200
M99
%
(@NCE-SIM:1 BEGIN TOOL)
(toolNumber=3200)
(description="End Mill 2 mm")
(holder=[{"type":"cylinder","diameter":2,"length":12,"stickOut":6}])
(cutting=[{"type":"endMill","diameter":2,"length":6}])
(orientation=[0,90,0])
(@NCE-SIM:1 END TOOL)
(@NCE-SIM:1 BEGIN TOOL)
(toolNumber=100)
(description="Turning Insert V 4.8 mm")
(Q=3)
(R=0.2)
(holder=[{"type":"turningHolderProfile","width":12,"depth":12,"outline":[[-0.5,1],[-0.5,40],[-12.5,40],[-12.5,14],[-7.5,9],[-7.5,1.367]],"stickOut":15,"position":[8,0,0]}])
(cutting=[{"type":"insert","shape":"V","ic":4.7625,"thickness":1.59,"noseRadius":0.2,"clearanceAngle":7,"zeroVertex":0,"rotation":[0,18,0]}])
(orientation=[0,90,0])
(turning={"hand":"right","mount":"front","approachAngle":93,"activeCorner":"front-right","reference":"virtualTip"})
(@NCE-SIM:1 END TOOL)
(@NCE-SIM:1 BEGIN SETUP)
(machineName="FANUC_STAR_SR20R_IV_B")
(material={"type":"cylinder","diameter":20,"length":20,"zeroVertex":0})
(@NCE-SIM:1 END SETUP)
(@NCE-SIM:1 BEGIN TOOL)
(toolNumber=3300)
(description="Front End Mill 0.5 mm")
(holder=[{"type":"cylinder","diameter":1.5,"length":12,"stickOut":3}])
(cutting=[{"type":"endMill","diameter":0.5,"length":3}])
(orientation=[0,180,0])
(@NCE-SIM:1 END TOOL)
